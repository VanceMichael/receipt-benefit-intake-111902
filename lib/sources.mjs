// 三方来源 HTTP 适配器：出票机构、门店收银、协会结款入口。
// 所有写操作携带稳定的 requestKey，协会按经办号幂等受理。

async function getJson(baseUrl, path) {
  const response = await fetch(baseUrl + path);
  if (!response.ok) {
    throw new SourceError('GET ' + path + ' 返回 ' + response.status, response.status, await safeJson(response));
  }
  return response.json();
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    throw new SourceError('POST ' + path + ' 返回 ' + response.status, response.status, payload);
  }
  return payload;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class SourceError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.payload = payload;
  }
}

export function createIssuerClient(baseUrl) {
  return {
    // 票根原始票号、换开关系、参与人序号与权益转移说明
    fetchTickets() {
      return getJson(baseUrl, '/issuer/tickets');
    },
  };
}

export function createPosClient(baseUrl) {
  return {
    // 按终端与营业日编号的收银流水，含午夜后补传与按原销售行定位的冲销
    fetchLedger() {
      return getJson(baseUrl, '/pos/ledger');
    },
  };
}

export function createAssociationClient(baseUrl) {
  return {
    // 正常结款
    async submitCredit({ requestKey, merchant, origin, cents }) {
      return postJson(baseUrl, '/association/credits', { requestKey, merchant, origin, cents });
    },
    // 已结后冲销：挂可追认的调减，带原受理号
    async submitAdjustment({ requestKey, merchant, origin, cents, priorReceipt }) {
      return postJson(baseUrl, '/association/credits', {
        requestKey, merchant, origin, cents, priorReceipt,
      });
    },
    // 按经办号回查受理号与状态
    async lookup(requestKey) {
      return getJson(baseUrl, '/association/credits?requestKey=' + encodeURIComponent(requestKey));
    },
  };
}
