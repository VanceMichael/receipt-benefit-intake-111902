import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcile, lineKeyOf, buildTicketCatalog } from '../lib/engine.mjs';

const baseTicket = {
  ticket: 'F-12',
  campaign: 'W26',
  participants: [1, 2, 3],
  eligible: [1, 2],
  validFrom: '2026-11-19T00:00:00+08:00',
  validUntil: '2026-11-21T00:00:00+08:00',
  merchants: ['双栖书屋', '桥东食集'],
};

const apply = (overrides = {}) => ({
  merchant: '双栖书屋',
  terminal: 'M8',
  businessDay: '2026-11-19',
  saleNo: 3,
  line: 1,
  type: 'apply',
  ticket: 'F-12',
  participant: 2,
  cents: 800,
  at: '2026-11-19T22:10:00+08:00',
  ...overrides,
});

const reverse = (target, overrides = {}) => ({
  merchant: target.merchant,
  terminal: target.terminal,
  businessDay: target.businessDay,
  saleNo: 90,
  line: 1,
  type: 'reverse',
  origin: [target.merchant, target.terminal, target.businessDay, target.saleNo, target.line],
  at: '2026-11-20T09:30:00+08:00',
  ...overrides,
});

test('依据完整的两条抵扣各自占用一个有效权益并可结款', () => {
  const line1 = apply({ line: 1, participant: 2 });
  const line2 = apply({ line: 2, participant: 1 });
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [line1, line2], scope: {} });

  assert.equal(report.summary.eligible, 2);
  assert.deepEqual(report.actions.credits.map(item => item.cents), [800, 800]);
  assert.deepEqual(report.entitlements.map(item => item.slotId).sort(),
    ['F-12#P1', 'F-12#P2']);
});

test('同一参与人权益被占用时，第二家商户争用同一权益不得放行', () => {
  const first = apply({ line: 1, participant: 1, merchant: '双栖书屋' });
  const second = apply({
    line: 1, saleNo: 7, participant: 1, merchant: '桥东食集', businessDay: '2026-11-20',
    at: '2026-11-20T10:00:00+08:00',
  });
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [first, second], scope: {} });

  const blocked = report.lines.find(item => item.key === lineKeyOf(second));
  assert.equal(blocked.status, 'pending');
  assert.equal(blocked.reason, 'entitlement-occupied');
  assert.equal(blocked.followUp, 'store');
  assert.equal(blocked.contender, lineKeyOf(first));
  assert.equal(report.actions.credits.length, 1); // 暂缓不占用可结账额度
});

test('冲销按原销售行定位后权益退回，后续抵扣可重新占用', () => {
  const first = apply({ line: 1, participant: 2 });
  const reversal = reverse(first);
  const second = apply({
    line: 1, saleNo: 8, merchant: '桥东食集', businessDay: '2026-11-20',
    at: '2026-11-20T11:00:00+08:00',
  });
  const report = reconcile({
    issuerDocs: [baseTicket],
    ledger: [first, reversal, second],
    scope: {},
  });

  const reversedLine = report.lines.find(item => item.key === lineKeyOf(first));
  assert.equal(reversedLine.status, 'reversed');
  assert.equal(reversedLine.reversedAt, reversal.at);
  const nextLine = report.lines.find(item => item.key === lineKeyOf(second));
  assert.equal(nextLine.status, 'eligible');
});

test('同一终端换日后的流水不能冲另一笔：跨终端/营业日冲销拒绝', () => {
  const first = apply({ line: 1 });
  const bad = reverse(first, { terminal: 'M9', businessDay: '2026-11-20', saleNo: 5 });
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [first, bad], scope: {} });

  assert.equal(report.lines.find(item => item.key === lineKeyOf(first)).status, 'eligible');
  assert.deepEqual(report.pending.map(item => item.reason), ['reversal-cross-terminal']);
  assert.equal(report.pending[0].followUp, 'store');
});

test('冲销找不到原销售行时待补，且不影响其他独立明细', () => {
  const good = apply({ line: 2, participant: 1 });
  const orphan = reverse(apply({ saleNo: 99, line: 9 }));
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [good, orphan], scope: {} });

  assert.equal(report.pending[0].reason, 'reversal-unknown-origin');
  assert.equal(report.lines.find(item => item.key === lineKeyOf(good)).status, 'eligible');
});

test('重复冲销同一销售行只承认一次', () => {
  const first = apply({ line: 1 });
  const r1 = reverse(first, { saleNo: 90 });
  const r2 = reverse(first, { saleNo: 91, at: '2026-11-20T10:00:00+08:00' });
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [first, r1, r2], scope: {} });

  assert.equal(report.pending.filter(item => item.reason === 'duplicate-reversal').length, 1);
});

test('换开票转移：原销售行未冲销前新持有人不可用，冲销后放行', () => {
  const transferDoc = {
    ticket: 'F-64',
    campaign: 'W26',
    transfers: [{
      fromTicket: 'F-12', fromParticipant: 2, toParticipant: 1,
      effective: '2026-11-20T09:00:00+08:00', requiresReversal: true,
    }],
  };
  const original = apply({ line: 1, participant: 2 });
  const reissued = apply({
    ticket: 'F-64', participant: 1, merchant: '桥东食集',
    businessDay: '2026-11-20', saleNo: 3, line: 1,
    at: '2026-11-20T10:00:00+08:00',
  });

  const before = reconcile({
    issuerDocs: [baseTicket, transferDoc], ledger: [original, reissued], scope: {},
  });
  const blocked = before.lines.find(item => item.key === lineKeyOf(reissued));
  assert.equal(blocked.status, 'pending');
  assert.equal(blocked.reason, 'transfer-awaiting-reversal');
  assert.equal(blocked.followUp, 'store');
  assert.equal(blocked.contender, lineKeyOf(original));

  const after = reconcile({
    issuerDocs: [baseTicket, transferDoc],
    ledger: [original, reverse(original), reissued],
    scope: {},
  });
  assert.equal(after.lines.find(item => item.key === lineKeyOf(reissued)).status, 'eligible');
  // 换开票占用的是 P2 转出的转移槽位，与新持有人 P1 的原票权益互不干扰
  assert.ok(after.entitlements.some(item => item.slotId === 'F-12#P2->F-64#P1'));
  assert.ok(!after.entitlements.some(item => item.slotId === 'F-12#P2'));
});

test('转移生效时间未到时出示换开票，应找出票机构补件', () => {
  const transferDoc = {
    ticket: 'F-64',
    transfers: [{
      fromTicket: 'F-12', fromParticipant: 2, toParticipant: 1,
      effective: '2026-11-20T09:00:00+08:00', requiresReversal: false,
    }],
  };
  const early = apply({
    ticket: 'F-64', participant: 1, businessDay: '2026-11-20', saleNo: 1,
    at: '2026-11-20T08:00:00+08:00',
  });
  const report = reconcile({
    issuerDocs: [baseTicket, transferDoc], ledger: [early], scope: {},
  });
  assert.equal(report.lines[0].reason, 'transfer-not-effective');
  assert.equal(report.lines[0].followUp, 'issuer');
});

test('适用时间、参与人序号、商户范围三类票据依据缺陷均由出票机构补件', () => {
  const outside = apply({ line: 1, at: '2026-11-22T10:00:00+08:00' });
  const notEligible = apply({ line: 2, participant: 3 });
  const wrongMerchant = apply({ line: 3, merchant: '路边摊', participant: 1 });
  const report = reconcile({
    issuerDocs: [baseTicket], ledger: [outside, notEligible, wrongMerchant], scope: {},
  });
  assert.deepEqual(report.lines.map(line => line.reason), [
    'ticket-outside-window',
    'participant-not-eligible',
    'merchant-not-covered',
  ]);
  assert.ok(report.lines.every(line => line.followUp === 'issuer'));
  assert.equal(report.actions.credits.length, 0);
});

test('未登记票根按出票机构待补，且不占用权益额度', () => {
  const unknown = apply({ ticket: 'F-99', line: 1 });
  const fine = apply({ line: 2, participant: 1 });
  const report = reconcile({ issuerDocs: [baseTicket], ledger: [unknown, fine], scope: {} });
  assert.equal(report.lines.find(item => item.key === lineKeyOf(unknown)).reason, 'ticket-unknown');
  assert.equal(report.actions.credits.length, 1);
});

test('已结款后收到原销售行冲销：挂可追认调减，其他明细照常可结', () => {
  const settled = apply({ line: 1, participant: 2 });
  const independent = apply({ line: 2, participant: 1 });
  const settlements = {
    [lineKeyOf(settled)]: {
      receipt: 'R-OLD-0001', requestKey: 'credit:old', cents: 800, adjusted: false,
    },
  };
  const report = reconcile({
    issuerDocs: [baseTicket],
    ledger: [settled, independent, reverse(settled)],
    settlements,
    scope: {},
  });

  const adjustedLine = report.lines.find(item => item.key === lineKeyOf(settled));
  assert.equal(adjustedLine.status, 'settled-adjusted');
  assert.equal(adjustedLine.settlement.receipt, 'R-OLD-0001');
  assert.equal(report.actions.adjustments.length, 1);
  assert.deepEqual(report.actions.adjustments[0], {
    requestKey: 'adjust:' + lineKeyOf(settled) + ':' + lineKeyOf(reverse(settled)),
    merchant: '双栖书屋',
    origin: ['双栖书屋', 'M8', '2026-11-19', 3, 1],
    cents: 800,
    priorReceipt: 'R-OLD-0001',
    lineKey: lineKeyOf(settled),
    reverseKey: lineKeyOf(reverse(settled)),
  });
  // 另一笔独立明细继续可领
  assert.equal(report.lines.find(item => item.key === lineKeyOf(independent)).status, 'eligible');
});

test('已挂调减不重复提交', () => {
  const settled = apply({ line: 1 });
  const settlements = {
    [lineKeyOf(settled)]: {
      receipt: 'R-OLD-0002', requestKey: 'credit:old2', cents: 800, adjusted: true,
    },
  };
  const report = reconcile({
    issuerDocs: [baseTicket],
    ledger: [settled, reverse(settled)],
    settlements,
    scope: {},
  });
  assert.equal(report.actions.adjustments.length, 0);
});

test('营业日范围只过滤可结动作，跨日补传的冲销仍能命中原营业日行', () => {
  const day1 = apply({ line: 1, participant: 2 });
  const reversal = reverse(day1, { at: '2026-11-20T00:20:00+08:00' }); // 午夜后补传
  const report = reconcile({
    issuerDocs: [baseTicket],
    ledger: [day1, reversal],
    scope: { businessDay: '2026-11-19' },
  });
  assert.equal(report.lines.find(item => item.key === lineKeyOf(day1)).status, 'reversed');
  assert.equal(report.actions.credits.length, 0);
  assert.equal(report.summary.inScope, 1);
});

test('争用未解时两家都不放行：依据未定的两笔同权益抵扣均保持暂缓', () => {
  // 两笔都依赖同一张换开票转移、且原销售行冲销未到：谁都不能占用权益
  const transferDoc = {
    ticket: 'F-64',
    transfers: [{
      fromTicket: 'F-12', fromParticipant: 2, toParticipant: 1,
      effective: '2026-11-20T09:00:00+08:00', requiresReversal: true,
    }],
  };
  const original = apply({ line: 1, participant: 2 });
  const a = apply({ ticket: 'F-64', participant: 1, merchant: '双栖书屋',
    businessDay: '2026-11-20', saleNo: 1, line: 1, at: '2026-11-20T10:00:00+08:00' });
  const b = apply({ ticket: 'F-64', participant: 1, merchant: '桥东食集',
    businessDay: '2026-11-20', saleNo: 2, line: 1, at: '2026-11-20T10:05:00+08:00' });
  const report = reconcile({
    issuerDocs: [baseTicket, transferDoc], ledger: [original, a, b], scope: {},
  });
  const f64Lines = report.lines.filter(item => item.pos.ticket === 'F-64');
  assert.equal(f64Lines.length, 2);
  assert.ok(f64Lines.every(item => item.status === 'pending' &&
    item.reason === 'transfer-awaiting-reversal'));
  // 原票那笔依据完整仍可结，两笔换开票均不得占用额度
  assert.equal(report.actions.credits.length, 1);
  // 冲销补到后，时序第一家放行，另一家仍因争用待补而非自动放行
  const resolved = reconcile({
    issuerDocs: [baseTicket, transferDoc],
    ledger: [original, reverse(original), a, b],
    scope: {},
  });
  assert.equal(resolved.lines.find(item => item.key === lineKeyOf(a)).status, 'eligible');
  const stillBlocked = resolved.lines.find(item => item.key === lineKeyOf(b));
  assert.equal(stillBlocked.status, 'pending');
  assert.equal(stillBlocked.reason, 'entitlement-occupied');
});

test('票券目录能识别换开票与转移索引', () => {
  const catalog = buildTicketCatalog([baseTicket, {
    ticket: 'F-64',
    transfers: [{ fromTicket: 'F-12', fromParticipant: 2, toParticipant: 1,
      effective: 'x', requiresReversal: true }],
  }]);
  assert.ok(catalog.reissuedTickets.has('F-64'));
  assert.ok(catalog.transferIndex.has('F-12|P2'));
  assert.equal(catalog.baseByTicket.get('F-12').campaign, 'W26');
});
