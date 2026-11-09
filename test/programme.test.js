'use strict';

/**
 * The full created-request flow, with the operator API, the SMS gateway and
 * the database stubbed out: the calls are recorded, so we can assert exactly
 * which status the row was moved through and which SMS went out.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { Status } = require('../src/constants/status');
const { DEFAULT_PROVIDERS } = require('../src/sms/operators/providers');
const { handleCreatedRequest, handleReceivedMessage, sweepTimeouts } = require('../programme');

function calls() {
  const record = [];
  return {
    record,
    apiConfigured: () => true,
    gatewayConfigured: () => true,
    save: async (id, tsp, status) => {
      record.push(['save', id, tsp, status]);
      return { Id: id, TSP: tsp, Status: status };
    },
    mark: async (id, status) => {
      record.push(['mark', id, status]);
      return { Id: id, Status: status };
    },
    send: async ({ to, text }) => {
      record.push(['send', to, text]);
      return { id: 'gw-1', state: 'Pending' };
    },
    list: async () => DEFAULT_PROVIDERS,
    detect: async (queryNumber) => {
      record.push(['detect', queryNumber]);
      return { operator: 'Airtel', circle: 'Maharashtra', connection: 'prepaid', ported: false };
    },
  };
}

describe('handleCreatedRequest', () => {
  it('looks the operator up, stores it, then sends one SMS to that carrier', async () => {
    const deps = calls();

    await handleCreatedRequest(
      { Id: 'req-1', QueryNumber: '+919876543210' },
      { detect: deps.detect, send: deps.send, list: deps.list, save: deps.save, mark: deps.mark, apiConfigured: deps.apiConfigured, gatewayConfigured: deps.gatewayConfigured },
    );

    assert.deepEqual(deps.record, [
      ['save', 'req-1', null, Status.TSP_REQUESTED],
      ['detect', '+919876543210'],
      ['save', 'req-1', 'Airtel', Status.TSP_FOUND],
      ['send', '088001 12112', '919876543210'],
      ['mark', 'req-1', Status.LOCATION_REQUESTED],
    ]);
  });

  it('uses the request format of the detected carrier', async () => {
    const deps = calls();
    const detect = async () => ({ operator: 'Vi (Vodafone Idea)', circle: '', connection: '', ported: false });

    await handleCreatedRequest(
      { Id: 'req-2', QueryNumber: '9876543210' },
      {
        detect,
        send: deps.send,
        list: deps.list,
        save: deps.save,
        mark: deps.mark,
        apiConfigured: deps.apiConfigured,
        gatewayConfigured: deps.gatewayConfigured,
      },
    );

    assert.deepEqual(deps.record.find((r) => r[0] === 'save' && r[2] === 'Vi (Vodafone Idea)'), [
      'save',
      'req-2',
      'Vi (Vodafone Idea)',
      Status.TSP_FOUND,
    ]);
    assert.deepEqual(deps.record.find((r) => r[0] === 'send'), ['send', '078248 34221', 'CELL 919876543210']);
  });

  it('leaves the row alone when the operator call throws', async () => {
    const deps = calls();
    const detect = async () => {
      throw new Error('operator API down');
    };

    await handleCreatedRequest(
      { Id: 'req-3', QueryNumber: '9876543210' },
      {
        detect,
        send: deps.send,
        list: deps.list,
        save: deps.save,
        mark: deps.mark,
        apiConfigured: deps.apiConfigured,
        gatewayConfigured: deps.gatewayConfigured,
      },
    );

    // No operator stored, no SMS sent, nothing marked as location requested.
    assert.equal(deps.record.some((r) => r[0] === 'send'), false);
    assert.equal(deps.record.some((r) => r[0] === 'mark'), false);
    assert.deepEqual(deps.record[0], ['save', 'req-3', null, Status.TSP_REQUESTED]);
  });

  it('does not mark the row when the gateway send fails', async () => {
    const deps = calls();
    const send = async () => {
      throw new Error('gateway 401');
    };

    await handleCreatedRequest(
      { Id: 'req-4', QueryNumber: '9876543210' },
      {
        detect: deps.detect,
        send,
        list: deps.list,
        save: deps.save,
        mark: deps.mark,
        apiConfigured: deps.apiConfigured,
        gatewayConfigured: deps.gatewayConfigured,
      },
    );

    assert.equal(deps.record.some((r) => r[0] === 'mark'), false);
    assert.equal(deps.record.some((r) => r[0] === 'save' && r[2] === 'Airtel'), true);
  });

  it('does nothing when the gateway has no credentials', async () => {
    const deps = calls();

    await handleCreatedRequest(
      { Id: 'req-5', QueryNumber: '9876543210' },
      {
        detect: deps.detect,
        send: deps.send,
        list: deps.list,
        save: deps.save,
        mark: deps.mark,
        apiConfigured: deps.apiConfigured,
        gatewayConfigured: () => false,
      },
    );

    assert.equal(deps.record.some((r) => r[0] === 'send'), false);
    assert.equal(deps.record.some((r) => r[0] === 'mark'), false);
  });

  it('skips the operator call when no key is configured', async () => {
    const deps = calls();
    const { config } = require('../src/config');
    const fallback = config.sms.nodalNumber;
    try {
      // Make the fallback deterministic, whatever this machine's .env holds.
      config.sms.nodalNumber = '55990';

      await handleCreatedRequest(
        { Id: 'req-6', QueryNumber: '9876543210' },
        {
          detect: deps.detect,
          send: deps.send,
          list: deps.list,
          save: deps.save,
          mark: deps.mark,
          apiConfigured: () => false,
          gatewayConfigured: deps.gatewayConfigured,
        },
      );

      assert.equal(deps.record.some((r) => r[0] === 'detect'), false);
      assert.equal(deps.record.some((r) => r[0] === 'save' && r[2] === 'Airtel'), false);
      assert.deepEqual(deps.record.find((r) => r[0] === 'send'), ['send', '55990', '919876543210']);
    } finally {
      config.sms.nodalNumber = fallback;
    }
  });
});

describe('handleReceivedMessage', () => {
  it('attaches a matching reply and reports the row', async () => {
    const seen = [];
    const record = async (input) => {
      seen.push(input);
      return { Id: 'req-9', QueryNumber: '9876543210', Status: Status.NODAL_RESPONSE_FOUND };
    };

    await handleReceivedMessage(
      { Sender: '08800112112', Message: 'Location of 91-98765 43210 is Tower A' },
      { record },
    );

    assert.deepEqual(seen[0].candidates, ['919876543210']);
    assert.equal(seen[0].text, 'Location of 91-98765 43210 is Tower A');
  });

  it('logs and carries on when nothing matches', async () => {
    const record = async () => null;

    await handleReceivedMessage({ Sender: '08800112112', Message: 'no number here' }, { record });
  });

  it('publishes the reply to the BotResponse channel when a number matches', async () => {
    let published = null;
    const record = async (input) => {
      return {
        Id: 'req-pub-1',
        QueryNumber: '9876543210',
        ChatId: BigInt('-9876543210'),
        UserId: BigInt('111222333'),
        Status: Status.NODAL_RESPONSE_FOUND,
      };
    };

    await handleReceivedMessage(
      { Sender: '07021265165', Message: 'Location of 91-98765 43210 is Tower A' },
      { record, publish: async (request) => { published = request; } },
    );

    assert.ok(published, 'a reply payload should be published');
    assert.equal(published.QueryNumber, '9876543210');
    assert.equal(published.ChatId, String('-9876543210'));
  });
});

describe('sweepTimeouts', () => {
  it('times out overdue requests', async () => {
    let observed;
    const sweep = async (options) => {
      observed = options;
      return 2;
    };

    const count = await sweepTimeouts({ sweep });
    assert.equal(count, 2);
    assert.equal(observed.waitMs, 15 * 60 * 1000);
    assert.equal(observed.sweepMs, 30 * 1000);
  });

  it('swallows a database failure', async () => {
    const sweep = async () => {
      throw new Error('database down');
    };
    assert.equal(await sweepTimeouts({ sweep }), 0);
  });
});
