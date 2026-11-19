# 出票、收银和协会对账资料接口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4，无第三方依赖。

- 运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
- 运行 `npm run app` 启动对账服务，默认 `http://127.0.0.1:3200`，通过 `APP_PORT` 与 `SOURCE_URL` 配置。
- 运行 `npm test` 执行全部测试（来源契约、引擎规则、端到端对账共 26 项）。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /issuer/tickets` ticket、participant 指出票方身份。transfers 表示权益随部分参与者转移，条件为上一笔销售行已冲销。
- `GET /pos/ledger` 原流水键为 merchant、terminal、businessDay、saleNo、line，timestamps 可晚于营业日。金额单位为分。
- `POST /association/credits` 受理字段 requestKey、merchant、origin、cents；调减另带 priorReceipt。
- `GET /association/credits` 按 requestKey 查询结款受理号。

## 对账服务

代码分三层：`lib/engine.mjs`（纯领域判定）、`lib/sources.mjs`（三方 HTTP 适配器）、`lib/app.mjs`（编排与 HTTP 入口），`cli.mjs` 提供业务员命令行。

### HTTP 入口

| 方法与路径 | 用途 |
| --- | --- |
| `POST /reconciliations` | 发起某活动或营业日对账，body 可带 `campaign`、`businessDay`、`merchants`；自动提交依据完整的正常结款 |
| `POST /supplements` | 补件后重跑同一范围，提交已结行被冲销对应的可追认调减，并放行争用解除后的新合格行 |
| `GET /runs` / `GET /runs/:runId` | 列出/查看对账批次报告 |
| `GET /runs/:runId/lines/:lineKey` | 逐行追溯：商户小票、票根依据、权益槽位占用、冲销与已领结款 |
| `GET /pending` | 全部暂缓行及补件方向（`issuer` 出票机构 / `store` 收银门店） |
| `GET /settlements` | 已领结款明细与受理号 |

### 命令行

```
node cli.mjs run --campaign W26 --business-day 2026-11-19
node cli.mjs supplement --business-day 2026-11-19
node cli.mjs show RUN-001
node cli.mjs trace RUN-001 "双栖书屋|M8|2026-11-19|3|1"
node cli.mjs pending
```

## 判定规则

1. **票根领取原凭据**：按优惠适用时间、参与人序号（eligible）、商户范围逐项校验；换开票（如 F-64）沿出票机构 transfers 回到原票继承适用时间与商户范围。
2. **权益槽位**：一个有效权益按“票 + 参与人”建槽；换开票承载的是转出参与人的权益，槽位标记为 `F-12#P2->F-64#P1`，与新持有人在原票下的自有权益互不占用。
3. **冲销定位**：冲销按原销售行五元组定位，须同商户、同终端、同营业日；午夜后补传但营业日归属不变的冲销依旧有效，重复冲销与跨终端冲销列入待补。冲销确认后释放对应槽位。
4. **票换开**：转移是否可再用同时看出票机构转移说明（生效时间、requiresReversal）与上一笔抵扣是否确已退回，不能只看票的新旧；条件未满足时暂缓并指向收银门店补冲销凭据。
5. **争用拦截**：同一槽位仍被未冲销抵扣占用时，新抵扣暂缓且不占可结账额度；争用未解时不会给两家都放行，报告给出争用行键。
6. **先结后调**：依据完整的明细先行结款；结款确认后才收到原销售行冲销的，在补件批次挂一笔带 `priorReceipt` 的可追认调减，其他独立明细继续领。
7. **补件方向**：票据类缺陷（票号、适用时间、参与人、商户范围、转移说明）找出票机构；冲销与重复抵扣类缺陷找收银门店。
8. **幂等**：结款与调减使用由行键派生的稳定 requestKey，协会按经办号追认，重复对账不会重复请款。
