import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../source.mjs';
import { createApp } from '../lib/app.mjs';

// ---- 真实来源服务 + 对账服务 -------------------------------------------

const source = createSource().listen(0, '127.0.0.1');
await once(source, 'listening');
const sourceUrl = 'http://127.0.0.1:' + source.address().port;

const app = createApp({ sourceUrl });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const appUrl = 'http://127.0.0.1:' + app.server.address().port;

test.after(async () => {
  app.server.close();
  source.close();
  await once(app.server, 'close');
  await once(source, 'close');
});

const call = async (method, path, body) => {
  const response = await fetch(appUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { status: response.status, payload };
};

async function switchPhase(phase) {
  const response = await fetch(sourceUrl + '/replay/phase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  assert.equal(response.status, 200);
}

// 每个用例从干净的经办状态与阶段 0 开始，避免内存状态串扰
test.beforeEach(async () => {
  app.reset();
  await switchPhase(0);
});

const key31 = '双栖书屋|M8|2026-11-19|3|1';
const key32 = '双栖书屋|M8|2026-11-19|3|2';
const key44 = '双栖书屋|M8|2026-11-19|44|1';
const keyQd1 = '桥东食集|M8|2026-11-20|3|1';
const keyQd2 = '桥东食集|M8|2026-11-20|3|2';

// ---- 阶段 0：家庭票两位参与人在指定商户的首笔对账 -----------------------

test('阶段0：两条抵扣依据完整并提交协会结款，受理号可回查', async () => {
  const { status, payload: run } = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-19',
  });
  assert.equal(status, 201);
  assert.match(run.runId, /^RUN-\d{3}$/);
  assert.equal(run.summary.inScope, 2);
  assert.equal(run.summary.settled, 2);
  assert.equal(run.summary.pending, 0);

  const lines = Object.fromEntries(run.lines.map(line => [line.key, line]));
  // 请款成功后最终报告反映为已结；权益槽位与票根依据仍完整保留
  assert.equal(lines[key31].status, 'settled');
  assert.equal(lines[key31].slotId, 'F-12#P2');
  assert.equal(lines[key31].ticketEvidence.baseTicket, 'F-12');
  assert.equal(lines[key32].slotId, 'F-12#P1');
  assert.deepEqual(run.entitlements.map(item => item.slotId).sort(), ['F-12#P1', 'F-12#P2']);

  // 协会已受理并给出受理号
  assert.equal(run.receipts.length, 2);
  assert.ok(run.receipts.every(item => item.receipt.startsWith('R-')));
  const receipts = await call('GET', '/settlements');
  assert.equal(receipts.payload.settlements.length, 2);
  assert.equal(receipts.payload.settlements.reduce((sum, item) => sum + item.cents, 0), 1600);

  // 经办号幂等：协会侧可按 requestKey 回查
  const lookup = await fetch(sourceUrl + '/association/credits?requestKey=' +
    encodeURIComponent('credit:' + key31)).then(res => res.json());
  assert.equal(lookup.state, '已受理');
});

test('阶段0：重复发起同范围对账不会向协会重复请款', async () => {
  const first = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-19',
  });
  const rerun = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-19',
  });
  assert.notEqual(rerun.payload.runId, first.payload.runId);
  assert.equal(rerun.payload.actions.credits.length, 0);
  assert.equal(rerun.payload.receipts.length, 0);
  assert.ok(rerun.payload.lines.every(line => line.status === 'settled'));
});

test('阶段0：逐行追溯可串起小票、票根、权益占用与结款', async () => {
  const { payload: run } = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-19',
  });
  const { status, payload: traced } = await call('GET',
    '/runs/' + run.runId + '/lines/' + encodeURIComponent(key31));
  assert.equal(status, 200);
  assert.equal(traced.posReceipt.ticket, 'F-12');
  assert.equal(traced.posReceipt.cents, 800);
  assert.equal(traced.ticketEvidence.presentedTicket, 'F-12');
  assert.equal(traced.entitlement.slotId, 'F-12#P2');
  assert.equal(traced.entitlement.status, 'occupied-by-this-line');
  assert.match(traced.settlement.receipt, /^R-/);
  assert.equal(traced.hold, null);
});

// ---- 阶段 1：换开票、补传冲销、调减与争用 -------------------------------

test('阶段1：补件重跑前一营业日，已结行被冲销时挂可追认调减', async () => {
  // 先在阶段 0 完成结款
  const initial = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-19',
  });
  const priorReceipt = initial.payload.lines.find(line => line.key === key31).settlement.receipt;

  await switchPhase(1);
  const { payload: run } = await call('POST', '/supplements', {
    campaign: 'W26', businessDay: '2026-11-19',
  });

  // 原 3|1 已结且收到 44|1 冲销 -> settled-adjusted + 一笔调减
  const target = run.lines.find(line => line.key === key31);
  assert.equal(target.status, 'settled-adjusted');
  assert.equal(target.reversedAt, '2026-11-20T09:30:00+08:00');
  assert.equal(target.reverseKey, key44);
  assert.equal(run.actions.adjustments.length, 1);
  const adjustment = run.actions.adjustments[0];
  assert.equal(adjustment.merchant, '双栖书屋');
  assert.equal(adjustment.cents, 800);
  assert.equal(adjustment.priorReceipt, priorReceipt);
  assert.ok(adjustment.requestKey.startsWith('adjust:'));
  assert.equal(run.receipts.filter(item => item.kind === 'adjustment').length, 1);

  // 另一行独立明细不受影响，保持已结
  const other = run.lines.find(line => line.key === key32);
  assert.equal(other.status, 'settled');

  // 调减幂等：再跑不重复挂账
  const again = await call('POST', '/supplements', { businessDay: '2026-11-19' });
  assert.equal(again.payload.actions.adjustments.length, 0);
});

test('阶段1：换开票转移条件满足后新持有人可抵扣，不因结算周期未切拒绝新流水', async () => {
  await switchPhase(1);
  const { payload: run } = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-20',
  });

  // 桥东 F-64 参与人1：转移生效(09:00)且原销售行冲销(09:30)均早于抵扣(10:00)
  const reissued = run.lines.find(line => line.key === keyQd1);
  assert.equal(reissued.status, 'settled'); // 已通过校验并完成请款
  assert.equal(reissued.ticketEvidence.presentedTicket, 'F-64');
  assert.equal(reissued.ticketEvidence.baseTicket, 'F-12');
  assert.equal(reissued.ticketEvidence.transfer.fromParticipant, 2);
  assert.ok(run.receipts.some(item => item.lineKey === keyQd1 && item.kind === 'credit'));

  // 同店 F-12 参与人1 再次抵扣：权益仍被双栖 3|2 占用，争用拦截
  const duplicate = run.lines.find(line => line.key === keyQd2);
  assert.equal(duplicate.status, 'pending');
  assert.equal(duplicate.reason, 'entitlement-occupied');
  assert.equal(duplicate.followUp, 'store');
  assert.equal(duplicate.contender, key32);

  // 暂缓不占用可结账额度：本批只有 F-64 一笔 800 分请款
  const creditReceipts = run.receipts.filter(item => item.kind === 'credit');
  assert.equal(creditReceipts.length, 1);
  assert.equal(creditReceipts[0].lineKey, keyQd1);
  assert.equal(app._settlements.get(keyQd1).cents, 800);
  assert.equal(run.summary.pending, 1);
});

test('阶段1：暂缓清单标明该找出票机构还是收银门店', async () => {
  await switchPhase(1);
  const run = await call('POST', '/reconciliations', { businessDay: '2026-11-20' });
  const { payload } = await call('GET', '/pending');
  const pending = payload.pending.find(item => item.key === keyQd2);
  assert.equal(pending.runId, run.payload.runId);
  assert.equal(pending.reason, 'entitlement-occupied');
  assert.equal(pending.followUp, 'store');
  assert.equal(pending.contender, key32);
});

test('阶段1：追溯视图展示转移、冲销与争用全貌', async () => {
  await switchPhase(1);
  const { payload: run } = await call('POST', '/reconciliations', {
    campaign: 'W26', businessDay: '2026-11-20',
  });
  const traced = await call('GET',
    '/runs/' + run.runId + '/lines/' + encodeURIComponent(keyQd1));
  assert.equal(traced.payload.ticketEvidence.transfer.requiresReversal, true);
  assert.equal(traced.payload.entitlement.status, 'occupied-by-this-line');
  assert.match(traced.payload.settlement.receipt, /^R-/);

  const blocked = await call('GET',
    '/runs/' + run.runId + '/lines/' + encodeURIComponent(keyQd2));
  assert.equal(blocked.payload.hold.ask, 'store');
  assert.equal(blocked.payload.contender, key32);
  assert.equal(blocked.payload.ticketEvidence.presentedTicket, 'F-12');
});

test('阶段1：重跑不重复请款，且跨营业日范围互不串账', async () => {
  // 阶段 0 先结 19 日
  await call('POST', '/reconciliations', { campaign: 'W26', businessDay: '2026-11-19' });
  await switchPhase(1);
  // 20 日首批：F-64 结款、F-12 争用待补
  const first20 = await call('POST', '/reconciliations', { businessDay: '2026-11-20' });
  assert.equal(first20.payload.receipts.filter(item => item.kind === 'credit').length, 1);

  const day20 = await call('POST', '/reconciliations', { businessDay: '2026-11-20' });
  assert.equal(day20.payload.actions.credits.length, 0);
  assert.equal(day20.payload.lines.find(line => line.key === keyQd1).status, 'settled');
  assert.equal(day20.payload.lines.find(line => line.key === keyQd2).status, 'pending');

  const day19 = await call('POST', '/reconciliations', { businessDay: '2026-11-19' });
  const statuses = Object.fromEntries(day19.payload.lines.map(line => [line.key, line.status]));
  assert.equal(statuses[key31], 'settled-adjusted');
  assert.equal(statuses[key32], 'settled');
  // 19 日范围不夹带 20 日的行：范围外行不产生请款动作
  assert.ok(day19.payload.lines.filter(line => line.scope === 'out')
    .every(line => line.pos.businessDay === '2026-11-20'));
  assert.equal(day19.payload.actions.credits.length, 0);
  // 已结行的冲销调减仍待提交（本用例此前未走过补件）
  assert.equal(day19.payload.actions.adjustments.length, 1);

  // 补件提交调减后再次重跑：调减不重复挂账
  const supplemented = await call('POST', '/supplements', { businessDay: '2026-11-19' });
  assert.equal(supplemented.payload.receipts.filter(item => item.kind === 'adjustment').length, 1);
  const final19 = await call('POST', '/reconciliations', { businessDay: '2026-11-19' });
  assert.equal(final19.payload.actions.adjustments.length, 0);
  assert.equal(final19.payload.actions.credits.length, 0);
});

test('未知入口与未知批次返回 404', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/runs/RUN-999')).status, 404);
});
