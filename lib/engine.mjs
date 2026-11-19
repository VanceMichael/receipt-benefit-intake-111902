// 对账引擎：纯领域逻辑，输入为出票机构票券资料、收银流水和既有结款记录，
// 输出每一条抵扣的判定、权益占用、应提交协会的动作及补件指引。
// 金额单位均为分。

// ---- 工具与常量 ---------------------------------------------------------

/** 收银原流水键：merchant、terminal、businessDay、saleNo、line */
export function lineKeyOf(entry) {
  return [entry.merchant, entry.terminal, entry.businessDay, entry.saleNo, entry.line].join('|');
}

/** 冲销记录里 origin 数组还原为原销售行键 */
export function originKeyOf(reverseEntry) {
  const [merchant, terminal, businessDay, saleNo, line] = reverseEntry.origin;
  return [merchant, terminal, businessDay, saleNo, line].join('|');
}

/** 权益槽位：一张票下某一位参与人对应的一个可抵扣权益 */
function slotIdOf(ticket, participant) {
  // 换开票承载的是从原票参与人转出的权益，槽位随转移来源标识，
  // 与新持有人在原票下的自有权益区分开
  if (ticket.transfer) {
    return ticket.baseTicket + '#P' + ticket.transfer.fromParticipant +
      '->' + ticket.presentedTicket + '#P' + participant;
  }
  return ticket.baseTicket + '#P' + participant;
}

const ISSUER = 'issuer';
const STORE = 'store';

// 暂缓原因 -> 该找哪一方补件
const FOLLOW_UP = {
  'ticket-unknown': ISSUER,
  'ticket-outside-window': ISSUER,
  'participant-not-eligible': ISSUER,
  'merchant-not-covered': ISSUER,
  'transfer-not-found': ISSUER,
  'transfer-not-effective': ISSUER,
  'entitlement-transferred': ISSUER,
  'transfer-awaiting-reversal': STORE,
  'reversal-unknown-origin': STORE,
  'reversal-cross-terminal': STORE,
  'duplicate-reversal': STORE,
  'entitlement-occupied': STORE,
};

export function followUpParty(reason) {
  return FOLLOW_UP[reason] || null;
}

function detailOf(ticket) {
  return {
    presentedTicket: ticket.presentedTicket,
    baseTicket: ticket.baseTicket,
    participant: ticket.participant,
    transfer: ticket.transfer || null,
    validFrom: ticket.validFrom,
    validUntil: ticket.validUntil,
    merchantScope: ticket.merchants,
  };
}

// ---- 票券资料解析 -------------------------------------------------------

/**
 * 把出票机构资料整理成索引。
 * 票券文档可能是原始票（带 eligible/validFrom/...），也可能只带 transfers（换开票）。
 */
export function buildTicketCatalog(issuerDocs) {
  const baseByTicket = new Map();
  const transferIndex = new Map(); // `${fromTicket}|${fromParticipant}` -> transfer
  const reissuedTickets = new Set();

  for (const doc of issuerDocs) {
    if (doc.eligible) {
      baseByTicket.set(doc.ticket, {
        ticket: doc.ticket,
        campaign: doc.campaign,
        participants: [...doc.participants],
        eligible: [...doc.eligible],
        validFrom: doc.validFrom,
        validUntil: doc.validUntil,
        merchants: [...doc.merchants],
      });
    }
    for (const transfer of doc.transfers || []) {
      reissuedTickets.add(doc.ticket);
      transferIndex.set(transfer.fromTicket + '|P' + transfer.fromParticipant, {
        ...transfer,
        reissuedTicket: doc.ticket,
      });
    }
  }

  return { baseByTicket, transferIndex, reissuedTickets };
}

/**
 * 解析一笔抵扣出示的票根，返回可用于校验的权益描述。
 * 换开票（如 F-64）本身没有适用时间/商户范围，须沿转移说明回到原票 F-12 继承。
 */
function resolvePresentedTicket(catalog, entry) {
  const { baseByTicket, transferIndex, reissuedTickets } = catalog;
  const base = baseByTicket.get(entry.ticket);

  if (base) {
    return {
      ok: true,
      presentedTicket: entry.ticket,
      baseTicket: base.ticket,
      participant: entry.participant,
      transfer: null,
      campaign: base.campaign,
      eligible: base.eligible,
      validFrom: base.validFrom,
      validUntil: base.validUntil,
      merchants: base.merchants,
    };
  }

  if (reissuedTickets.has(entry.ticket)) {
    // 换开票：按转移记录定位到原票与参与人
    const transfer = [...transferIndex.values()]
      .find(item => item.reissuedTicket === entry.ticket && item.toParticipant === entry.participant);
    if (!transfer) {
      return { ok: false, reason: 'transfer-not-found' };
    }
    const source = baseByTicket.get(transfer.fromTicket);
    if (!source) return { ok: false, reason: 'ticket-unknown' };
    return {
      ok: true,
      presentedTicket: entry.ticket,
      baseTicket: source.ticket,
      participant: transfer.toParticipant,
      transfer,
      campaign: source.campaign,
      eligible: source.eligible,
      validFrom: source.validFrom,
      validUntil: source.validUntil,
      merchants: source.merchants,
    };
  }

  return { ok: false, reason: 'ticket-unknown' };
}

// ---- 冲销校验 -----------------------------------------------------------

function validateReversals(ledger, applyByKey) {
  const validReversals = [];
  const invalid = [];
  const seenOrigin = new Set();

  for (const entry of ledger.filter(item => item.type === 'reverse')) {
    const originKey = originKeyOf(entry);
    const target = applyByKey.get(originKey);
    if (!target) {
      invalid.push({ entry, reason: 'reversal-unknown-origin' });
      continue;
    }
    // 同一终端换日后的流水不能拿来冲另一笔：终端/营业日/商户不一致即拒绝
    if (target.merchant !== entry.merchant || target.terminal !== entry.terminal ||
        target.businessDay !== entry.businessDay) {
      invalid.push({ entry, reason: 'reversal-cross-terminal', origin: originKey });
      continue;
    }
    if (seenOrigin.has(originKey)) {
      invalid.push({ entry, reason: 'duplicate-reversal', origin: originKey });
      continue;
    }
    seenOrigin.add(originKey);
    validReversals.push({ entry, originKey, at: new Date(entry.at) });
  }
  return { validReversals, invalid };
}

// ---- 主流程 -------------------------------------------------------------

/**
 * 执行一次对账。
 *
 * @param {object} input
 * @param {Array}  input.issuerDocs   GET /issuer/tickets 的票券资料
 * @param {Array}  input.ledger       GET /pos/ledger 的收银流水（apply + reverse）
 * @param {object} input.settlements  已结款映射：lineKey -> { receipt, cents, requestKey, creditKey }
 * @param {object} input.scope        { campaign?, businessDay?, merchants? }
 */
export function reconcile({ issuerDocs, ledger, settlements = {}, scope = {} }) {
  const catalog = buildTicketCatalog(issuerDocs);
  const applies = ledger.filter(item => item.type === 'apply');
  const applyByKey = new Map(applies.map(entry => [lineKeyOf(entry), entry]));
  const { validReversals, invalid: invalidReversals } = validateReversals(ledger, applyByKey);
  const reverseByOrigin = new Map(validReversals.map(item => [item.originKey, item]));

  // 按事件时间重放：午夜后补传的冲销时间可能晚于次日营业日的抵扣
  const events = [
    ...applies.map(entry => ({ kind: 'apply', at: new Date(entry.at), entry })),
    ...validReversals.map(item => ({ kind: 'reverse', at: item.at, entry: item.entry, originKey: item.originKey })),
  ].sort((a, b) => a.at - b.at || lineKeyOf(a.entry).localeCompare(lineKeyOf(b.entry)));

  /** slotId -> 占用该权益的当前有效 apply 行键（冲销后释放） */
  const occupancy = new Map();
  /** lineKey -> 判定结果 */
  const decisions = new Map();

  for (const event of events) {
    if (event.kind === 'reverse') {
      const targetKey = event.originKey;
      const target = applyByKey.get(targetKey);
      const decision = decisions.get(targetKey);
      if (decision?.slotId && occupancy.get(decision.slotId) === targetKey) {
        occupancy.delete(decision.slotId); // 冲销确认，权益退回
      }
      if (decision) {
        decision.reversedAt = event.entry.at;
        decision.reverseKey = lineKeyOf(event.entry);
      }
      continue;
    }

    const entry = event.entry;
    const key = lineKeyOf(entry);
    const baseDecision = {
      key,
      entry,
      status: 'pending',
      reason: null,
      followUp: null,
      slotId: null,
      ticketEvidence: null,
      reversedAt: reverseByOrigin.get(key)?.entry.at || null,
      reverseKey: reverseByOrigin.get(key) ? lineKeyOf(reverseByOrigin.get(key).entry) : null,
      contender: null,
    };

    const resolved = resolvePresentedTicket(catalog, entry);
    if (!resolved.ok) {
      decisions.set(key, {
        ...baseDecision,
        reason: resolved.reason,
        followUp: followUpParty(resolved.reason),
      });
      continue;
    }
    baseDecision.ticketEvidence = detailOf(resolved);
    const slotId = slotIdOf(resolved, resolved.participant);
    baseDecision.slotId = slotId;

    // 1) 优惠适用时间
    const at = new Date(entry.at);
    if (at < new Date(resolved.validFrom) || at >= new Date(resolved.validUntil)) {
      decisions.set(key, {
        ...baseDecision,
        reason: 'ticket-outside-window',
        followUp: ISSUER,
      });
      continue;
    }
    // 2) 参与人是否在出票方列明的可享优惠序号内
    if (!resolved.eligible.includes(entry.participant)) {
      decisions.set(key, {
        ...baseDecision,
        reason: 'participant-not-eligible',
        followUp: ISSUER,
      });
      continue;
    }
    // 3) 商户范围
    if (resolved.merchants.length > 0 && !resolved.merchants.includes(entry.merchant)) {
      decisions.set(key, {
        ...baseDecision,
        reason: 'merchant-not-covered',
        followUp: ISSUER,
      });
      continue;
    }

    // 4) 换开票：看出票机构转移说明，以及上一笔抵扣是否确已退回
    if (resolved.transfer) {
      const transfer = resolved.transfer;
      if (at < new Date(transfer.effective)) {
        decisions.set(key, {
          ...baseDecision,
          reason: 'transfer-not-effective',
          followUp: ISSUER,
        });
        continue;
      }
      const priorSlot = transfer.fromTicket + '#P' + transfer.fromParticipant;
      const holderKey = occupancy.get(priorSlot);
      if (transfer.requiresReversal) {
        // 条件是“上一笔销售行已冲销”：找到当前或曾经占用该权益的抵扣行，
        // 以其冲销流水是否已到且不晚于本笔抵扣为准，不能只看槽位此刻是否为空
        const originKey = holderKey || [...decisions.entries()]
          .find(([, decision]) => decision.slotId === priorSlot)?.[0];
        const reversal = originKey ? reverseByOrigin.get(originKey) : null;
        const priorReversed = Boolean(reversal) && new Date(reversal.entry.at) <= at;
        if (!priorReversed) {
          // 转移条件未满足：需要收银门店确认上一销售行冲销
          decisions.set(key, {
            ...baseDecision,
            reason: 'transfer-awaiting-reversal',
            followUp: STORE,
            contender: originKey || null,
          });
          continue;
        }
      } else if (holderKey) {
        decisions.set(key, {
          ...baseDecision,
          reason: 'entitlement-transferred',
          followUp: ISSUER,
          contender: holderKey,
        });
        continue;
      }
    }

    // 5) 权益争用：同一权益槽位仍被一笔未冲销的有效抵扣占用
    const occupantKey = occupancy.get(slotId);
    if (occupantKey) {
      decisions.set(key, {
        ...baseDecision,
        reason: 'entitlement-occupied',
        followUp: STORE,
        contender: occupantKey,
      });
      continue;
    }

    // 依据完整：占用一个有效权益
    occupancy.set(slotId, key);
    decisions.set(key, { ...baseDecision, status: 'eligible', reason: null, followUp: null });
  }

  // ---- 汇总、范围过滤与结款动作 ----------------------------------------

  const inScope = entry => {
    let campaignHit = true;
    if (scope.campaign) {
      const base = catalog.baseByTicket.get(entry.ticket);
      const viaTransfer = [...catalog.transferIndex.values()]
        .some(t => t.reissuedTicket === entry.ticket &&
          catalog.baseByTicket.get(t.fromTicket)?.campaign === scope.campaign);
      campaignHit = base?.campaign === scope.campaign || viaTransfer;
    }
    const dayHit = !scope.businessDay || entry.businessDay === scope.businessDay;
    const merchantHit = !scope.merchants || scope.merchants.length === 0 ||
      scope.merchants.includes(entry.merchant);
    return campaignHit && dayHit && merchantHit;
  };

  const lines = [];
  const credits = [];
  const adjustments = [];
  let eligibleCount = 0;
  let pendingCount = 0;
  let settledCount = 0;

  for (const entry of applies) {
    const key = lineKeyOf(entry);
    const decision = decisions.get(key);
    const scopeHit = inScope(entry);
    const settlement = settlements[key];
    const isReversed = Boolean(decision?.reversedAt);

    let status;
    if (settlement) {
      status = isReversed ? 'settled-adjusted' : 'settled';
      settledCount += scopeHit ? 1 : 0;
    } else if (isReversed) {
      status = 'reversed'; // 冲销已退回，无需结款
    } else if (decision.status === 'eligible') {
      status = 'eligible';
      eligibleCount += scopeHit ? 1 : 0;
    } else {
      status = 'pending';
      pendingCount += scopeHit ? 1 : 0;
    }

    const line = {
      key,
      scope: scopeHit ? 'in' : 'out',
      pos: {
        merchant: entry.merchant,
        terminal: entry.terminal,
        businessDay: entry.businessDay,
        saleNo: entry.saleNo,
        line: entry.line,
        ticket: entry.ticket,
        participant: entry.participant,
        cents: entry.cents,
        at: entry.at,
      },
      status,
      reason: decision.reason,
      followUp: decision.followUp,
      slotId: decision.slotId,
      ticketEvidence: decision.ticketEvidence,
      contender: decision.contender,
      reversedAt: decision.reversedAt,
      reverseKey: decision.reverseKey,
      settlement: settlement ? {
        receipt: settlement.receipt,
        requestKey: settlement.requestKey,
        cents: settlement.cents,
      } : null,
    };
    lines.push(line);

    if (!scopeHit) continue;

    if (!settlement && status === 'eligible') {
      credits.push({
        requestKey: 'credit:' + key,
        merchant: entry.merchant,
        origin: [entry.merchant, entry.terminal, entry.businessDay, entry.saleNo, entry.line],
        cents: entry.cents,
        lineKey: key,
      });
    }
    // 调减跟随被冲销的原销售行归属：午夜后补传的冲销可能落在另一营业日
    if (settlement && isReversed && !settlement.adjusted) {
      adjustments.push({
        requestKey: 'adjust:' + key + ':' + decision.reverseKey,
        merchant: entry.merchant,
        origin: [entry.merchant, entry.terminal, entry.businessDay, entry.saleNo, entry.line],
        cents: settlement.cents,
        priorReceipt: settlement.receipt,
        lineKey: key,
        reverseKey: decision.reverseKey,
      });
    }
  }

  // 暂缓行（含冲销资料本身的缺陷），供补件清单使用
  const pendingItems = lines
    .filter(line => line.status === 'pending')
    .map(line => ({ key: line.key, reason: line.reason, followUp: line.followUp, contender: line.contender }));
  for (const item of invalidReversals) {
    pendingItems.push({
      key: lineKeyOf(item.entry),
      reason: item.reason,
      followUp: followUpParty(item.reason),
      origin: item.origin || null,
    });
  }

  return {
    scope,
    lines,
    pending: pendingItems,
    actions: { credits, adjustments },
    entitlements: [...occupancy.entries()].map(([slotId, ownerKey]) => ({ slotId, occupiedBy: ownerKey })),
    summary: {
      total: lines.length,
      inScope: lines.filter(line => line.scope === 'in').length,
      eligible: eligibleCount,
      pending: pendingCount,
      settled: settledCount,
      creditCents: credits.reduce((sum, item) => sum + item.cents, 0),
      adjustmentCents: adjustments.reduce((sum, item) => sum + item.cents, 0),
    },
  };
}
