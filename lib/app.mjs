// 对账应用服务：拉取三方资料 -> 引擎判定 -> 向协会提交结款/调减 -> 留存可追溯报告。
import { createServer } from 'node:http';
import { reconcile } from './engine.mjs';
import {
  SourceError,
  createIssuerClient,
  createPosClient,
  createAssociationClient,
} from './sources.mjs';

/**
 * @param {object} options
 * @param {string} options.sourceUrl 演练来源基址
 */
export function createApp({ sourceUrl = process.env.SOURCE_URL || 'http://127.0.0.1:3100' } = {}) {
  const issuer = createIssuerClient(sourceUrl);
  const pos = createPosClient(sourceUrl);
  const association = createAssociationClient(sourceUrl);

  // 已结款明细：lineKey -> { receipt, requestKey, cents, adjusted }
  const settlements = new Map();
  // 历次对账报告：runId -> report
  const runs = new Map();
  let runSequence = 0;

  async function readBody(request) {
    let input = '';
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 65536) throw new Error('请求正文超出限制');
    }
    return JSON.parse(input || '{}');
  }

  function send(response, status, value) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value, null, 2));
  }

  /**
   * 发起一次对账（活动或营业日）。
   * 只提交依据完整的正常结款；调减属于补件追认动作，留待 supplement 处理。
   */
  async function runReconciliation(scope, { submitAdjustments = false } = {}) {
    const [issuerDocs, ledger] = await Promise.all([
      issuer.fetchTickets(),
      pos.fetchLedger(),
    ]);

    const report = reconcile({
      issuerDocs,
      ledger,
      settlements: Object.fromEntries(settlements),
      scope,
    });

    const receipts = [];
    const plannedCredits = report.actions.credits;
    const plannedAdjustments = submitAdjustments ? report.actions.adjustments : [];
    // 先结已有完整依据的明细；暂缓行不占用可结账额度，故不提交
    for (const credit of plannedCredits) {
      const accepted = await association.submitCredit(credit);
      settlements.set(credit.lineKey, {
        receipt: accepted.receipt,
        requestKey: credit.requestKey,
        cents: credit.cents,
        adjusted: false,
      });
      receipts.push({ kind: 'credit', lineKey: credit.lineKey, receipt: accepted.receipt, state: accepted.state });
    }

    // 结款确认后才到的原销售行冲销：挂可追认调减，其他独立明细不受影响
    for (const adjustment of plannedAdjustments) {
      const accepted = await association.submitAdjustment(adjustment);
      const prior = settlements.get(adjustment.lineKey);
      if (prior) prior.adjusted = true;
      receipts.push({
        kind: 'adjustment',
        lineKey: adjustment.lineKey,
        receipt: accepted.receipt,
        priorReceipt: adjustment.priorReceipt,
        state: accepted.state,
      });
    }

    // 重新生成报告，使已提交结果反映到行状态；本次已执行的动作作为受理凭据保留
    const finalReport = reconcile({
      issuerDocs,
      ledger,
      settlements: Object.fromEntries(settlements),
      scope,
    });
    finalReport.actions = {
      credits: plannedCredits,
      // 普通对账批次仍展示待追认调减，供补件清单使用；补件批次展示本次已提交项
      adjustments: submitAdjustments ? plannedAdjustments : report.actions.adjustments,
    };
    finalReport.receipts = receipts;
    finalReport.runId = 'RUN-' + String(++runSequence).padStart(3, '0');
    runs.set(finalReport.runId, finalReport);
    return finalReport;
  }

  /** 补件后重跑：同一范围，提交调减追认；争用解除后新的合格行自动放行 */
  function supplement(scope) {
    return runReconciliation(scope, { submitAdjustments: true });
  }

  /** 对账员逐行追溯：票根、商户小票、权益占用与已领结款的对应关系 */
  function traceLine(runId, key) {
    const report = runs.get(runId);
    if (!report) return null;
    const line = report.lines.find(item => item.key === key);
    if (!line) return null;
    const entitlement = report.entitlements.find(item => item.occupiedBy === key);
    return {
      runId,
      line: key,
      posReceipt: line.pos,
      ticketEvidence: line.ticketEvidence,
      entitlement: line.slotId ? {
        slotId: line.slotId,
        status: entitlement ? 'occupied-by-this-line' : 'released-or-transferred',
        occupiedBy: entitlement ? key : (report.entitlements
          .find(item => item.slotId === line.slotId)?.occupiedBy || null),
      } : null,
      contender: line.contender,
      reversal: line.reversedAt ? { at: line.reversedAt, reverseKey: line.reverseKey } : null,
      settlement: line.settlement,
      hold: line.status === 'pending' ? { reason: line.reason, ask: line.followUp } : null,
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'POST' && url.pathname === '/reconciliations') {
        const body = await readBody(request);
        const scope = {
          campaign: body.campaign,
          businessDay: body.businessDay,
          merchants: body.merchants,
        };
        return send(response, 201, await runReconciliation(scope));
      }
      if (request.method === 'POST' && url.pathname === '/supplements') {
        const body = await readBody(request);
        return send(response, 201, await supplement({
          campaign: body.campaign,
          businessDay: body.businessDay,
          merchants: body.merchants,
        }));
      }
      if (request.method === 'GET' && url.pathname === '/runs') {
        return send(response, 200, { runIds: [...runs.keys()] });
      }
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runMatch) {
        const report = runs.get(decodeURIComponent(runMatch[1]));
        if (!report) return send(response, 404, { error: '查无对账批次' });
        return send(response, 200, report);
      }
      const traceMatch = url.pathname.match(/^\/runs\/([^/]+)\/lines\/(.+)$/);
      if (request.method === 'GET' && traceMatch) {
        const traced = traceLine(decodeURIComponent(traceMatch[1]), decodeURIComponent(traceMatch[2]));
        if (!traced) return send(response, 404, { error: '查无该行追溯资料' });
        return send(response, 200, traced);
      }
      if (request.method === 'GET' && url.pathname === '/pending') {
        const items = [...runs.values()].flatMap(report =>
          report.pending.map(item => ({ runId: report.runId, ...item })));
        return send(response, 200, { pending: items });
      }
      if (request.method === 'GET' && url.pathname === '/settlements') {
        return send(response, 200, {
          settlements: [...settlements.entries()].map(([key, value]) => ({ lineKey: key, ...value })),
        });
      }
      return send(response, 404, { error: '查无入口' });
    } catch (error) {
      if (error instanceof SourceError) {
        return send(response, 502, { error: error.message, upstream: error.payload });
      }
      if (error instanceof SyntaxError) {
        return send(response, 400, { error: '请求正文不是合法 JSON' });
      }
      return send(response, 500, { error: error.message });
    }
  });

  return {
    server,
    // 暴露给测试与 CLI
    runReconciliation,
    supplement,
    traceLine,
    /** 复位经办状态（测试或换演练资料时使用） */
    reset() {
      settlements.clear();
      runs.clear();
      runSequence = 0;
    },
    _settlements: settlements,
    _runs: runs,
  };
}
