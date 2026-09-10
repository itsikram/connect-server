const assert = require("node:assert/strict");
const test = require("node:test");
const { createSubmitPaymentHandler } = require("./paymentsController");

const requestBody = {
  paymentMethod: "bkash",
  senderMsisdn: "01700000000",
  transactionId: "TRX-123",
  type: "wallet_topup",
  amountBDT: 100,
};

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const createRequest = (body = requestBody) => ({
  body,
  profile: { user: { _id: "user-1" } },
});

test("submits a valid payment as pending", async () => {
  const created = { _id: "transaction-1", ...requestBody, status: "pending" };
  const calls = [];
  const TransactionModel = {
    countDocuments: async () => 0,
    findOne: () => ({ lean: async () => null }),
    create: async (payload) => {
      calls.push(payload);
      return created;
    },
  };
  const response = createResponse();

  await createSubmitPaymentHandler({ TransactionModel })(
    createRequest(),
    response,
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.success, true);
  assert.equal(calls[0].status, "pending");
  assert.equal(calls[0].userId, "user-1");
});

test("rejects a duplicate transaction ID and payment method", async () => {
  const TransactionModel = {
    countDocuments: async () => 0,
    findOne: () => ({ lean: async () => ({ _id: "existing" }) }),
    create: async () => {
      throw new Error("create should not be called");
    },
  };
  const response = createResponse();

  await createSubmitPaymentHandler({ TransactionModel })(
    createRequest(),
    response,
  );

  assert.equal(response.statusCode, 409);
  assert.match(response.body.message, /already been submitted/i);
});

test("rejects a sixth pending submission for the same user", async () => {
  const TransactionModel = {
    countDocuments: async () => 5,
    findOne: () => ({ lean: async () => null }),
    create: async () => {
      throw new Error("create should not be called");
    },
  };
  const response = createResponse();

  await createSubmitPaymentHandler({ TransactionModel })(
    createRequest({ ...requestBody, transactionId: "TRX-456" }),
    response,
  );

  assert.equal(response.statusCode, 429);
  assert.match(response.body.message, /at most 5 pending/i);
});
