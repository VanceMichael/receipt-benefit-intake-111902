# 出票、收银和协会对账资料接口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /issuer/tickets` ticket、participant 指出票方身份。transfers 表示权益随部分参与者转移，条件为上一笔销售行已冲销。
- `GET /pos/ledger` 原流水键为 merchant、terminal、businessDay、saleNo、line，timestamps 可晚于营业日。金额单位为分。
- `POST /association/credits` 受理字段 requestKey、merchant、origin、cents；调减另带 priorReceipt。
- `GET /association/credits` 按 requestKey 查询结款受理号。
