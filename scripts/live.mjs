import assert from 'node:assert/strict';
import fs from 'node:fs';
import {abi, createAccount, createClient} from 'genlayer-js';
import {studionet} from 'genlayer-js/chains';
import {sha, jsonSafe, rpc, receipt, source, read} from './check.mjs';

const journal = 'PROOFS.json';
const code = 'contracts/GuillotineCutPlanner.py';
const verifyOnly = process.argv.includes('--verify-only');
const resume = process.argv.includes('--resume');
const proof = fs.existsSync(journal)
  ? JSON.parse(fs.readFileSync(journal, 'utf8'))
  : {network: 'StudioNet', source_commit: process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? null,
    transactions: [], orders: {}};
const save = () => fs.writeFileSync(journal, JSON.stringify(proof, null, 2) + '\n');
assert.match(proof.source_commit ?? '', /^[a-f0-9]{40}$/);
assert.equal(await rpc('eth_chainId', []), '0xf22f');
assert.equal(studionet.id, 61999);

// Persist acknowledged sends before an SDK error or process interruption.
const originalFetch = globalThis.fetch;
const sent = new Map();
let currentEntry;
let deploymentFees;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  const request = JSON.parse(options?.body ?? '{}');
  if (url !== 'https://studio.genlayer.com/api' || request.method !== 'eth_sendRawTransaction') {
    return originalFetch(input, options);
  }
  assert(currentEntry && !currentEntry.hash, 'Inspect the journal before another send');
  const payload = request.params[0];
  assert.match(payload, /^0x[a-f0-9]+$/i);
  if (!sent.has(payload)) {
    currentEntry.raw_send_started = true;
    save();
    sent.set(payload, (async () => {
      const response = await originalFetch(input, options);
      const body = await response.text();
      const data = JSON.parse(body);
      if (data.result) {
        assert.match(data.result, /^0x[a-f0-9]{64}$/i);
        currentEntry.hash = data.result;
        save();
        console.log(currentEntry.step, data.result);
      }
      return {body, status: response.status};
    })());
  }
  const response = await sent.get(payload);
  return new Response(response.body, {status: response.status, headers: {'content-type': 'application/json'}});
};

async function transaction(step, account, functionName, args) {
  let entry = proof.transactions.find(tx => tx.step === step);
  if (!entry) {
    assert(!verifyOnly && account, 'Missing broadcast journal');
    const nonce = await rpc('eth_getTransactionCount', [account.address, 'latest']);
    assert.equal(await rpc('eth_getTransactionCount', [account.address, 'pending']), nonce);
    const fees = deploymentFees;
    assert(fees?.distribution);
    const feeValue = BigInt(fees.feeValue);
    assert(feeValue >= 0n && feeValue <= 1_000_000_000_000_000n, 'Studio quote exceeds demo budget');
    assert(BigInt(await rpc('eth_getBalance', [account.address, 'latest'])) >= feeValue);
    entry = {step, signer: account.address, nonce, functionName, args, fee_wei: String(feeValue),
      raw_send_started: false};
    proof.transactions.push(entry);
    save();
    currentEntry = entry;
    const client = createClient({chain: studionet, account});
    const hash = functionName === 'deploy'
      ? await client.deployContract({code: fs.readFileSync(code), args: [], fees, leaderOnly: false})
      : await client.writeContract({
        address: proof.address, functionName, args, value: 0n, fees, leaderOnly: false,
      });
    assert.equal(hash, entry.hash);
    currentEntry = undefined;
  }
  assert.deepEqual(entry.args, args);
  assert.equal(entry.functionName, functionName);
  assert(entry.hash, 'Broadcast status unknown. Inspect the recorded nonce before resuming.');
  const {summary, tx, leader} = await receipt(entry.hash);
  entry.receipt = summary;
  save();
  assert.equal(summary.status, 'FINALIZED');
  assert.equal(summary.execution, 'SUCCESS');
  assert.equal(summary.consensus, 'MAJORITY_AGREE');
  assert.equal(summary.leader_only, false);
  assert(summary.initial_validators >= 3 && summary.agree_votes >= 2 && summary.validator_execution_seen);
  assert.equal(tx.from_address.toLowerCase(), entry.signer.toLowerCase());
  assert.equal(BigInt(tx.nonce), BigInt(entry.nonce));
  assert.equal(BigInt(tx.value), 0n);
  const envelope = await rpc('eth_getTransactionReceipt', [entry.hash]);
  assert.equal(envelope.status, '0x1');
  assert.equal(envelope.from.toLowerCase(), entry.signer.toLowerCase());
  console.log(step, entry.receipt.status, entry.receipt.execution);
  if (functionName === 'deploy') return {address: entry.receipt.address};
  const bytes = Buffer.from(leader.result, 'base64');
  assert.equal(bytes[0], 0);
  return {address: entry.receipt.address, result: jsonSafe(abi.calldata.decode(bytes.subarray(1)))};
}

assert(verifyOnly ? proof.verified : proof.transactions.length === 0 || resume,
  'Use a fresh journal, --resume for acknowledged sends, or --verify-only');
if (resume && !verifyOnly) {
  const unsent = proof.transactions.filter(entry => !entry.hash && entry.raw_send_started === false);
  if (unsent.length) {
    proof.unsent_attempts ??= [];
    proof.unsent_attempts.push(...unsent);
    proof.transactions = proof.transactions.filter(entry => !unsent.includes(entry));
    save();
  }
}
assert(proof.transactions.every(entry => entry.hash),
  'An attempted send has no acknowledged hash; inspect its signer and nonce before continuing');

async function fund(transactionCount) {
  const {defaultFees: fees} = await rpc('sim_getFeeConfig', []);
  assert(fees?.distribution, 'Studio fee configuration missing');
  const fee = BigInt(fees.feeValue);
  assert(fee >= 0n && fee <= 1_000_000_000_000_000n, 'Studio quote exceeds demo budget');
  deploymentFees = fees;
  const account = createAccount();
  const amount = 10_000_000_000_000_000;
  const required = fee * BigInt(transactionCount);
  let balance = BigInt(await rpc('eth_getBalance', [account.address, 'latest']));
  for (let attempt = 0; balance < required && attempt < 2; attempt++) {
    try {
      const response = await fetch('https://studio.genlayer.com/api', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'sim_fundAccount', params: [account.address, amount]}),
        signal: AbortSignal.timeout(25000),
      });
      const reply = await response.json();
      if (!response.ok || reply.error) {
        console.log('Studio faucet status', response.status, reply.error?.code ?? '');
      }
    } catch {
      console.log('Checking balance after an unconfirmed faucet response');
    }
    balance = BigInt(await rpc('eth_getBalance', [account.address, 'latest']));
  }
  assert(balance >= required, 'Studio faucet balance does not cover the quoted test fees');
  proof.test_faucets ??= [];
  proof.test_faucets.push({address: account.address, verified_balance_wei: String(balance)});
  save();
  return account;
}

const cases = [
  {name: 'fixed', orientation: 'FIXED', count: 2},
  {name: 'rotatable', orientation: 'ROTATE', count: 3},
];
const completedSteps = new Set(proof.transactions.map(entry => entry.step));
const pending = ['deploy', ...cases.map(test => test.name)].filter(step => !completedSteps.has(step));
const account = verifyOnly || !pending.length ? null : await fund(pending.length);

const deployment = await transaction('deploy', account, 'deploy', []);
proof.address = deployment.address;
proof.source = await source(proof.address);
save();

function replayPlan(plan, stock, part, kerf, rotate) {
  const available = new Set([stock.join(',')]);
  for (const {box, axis, offset} of plan.cuts) {
    assert(available.delete(box.join(',')));
    const [x, y, w, h] = box;
    const opposite = (axis === 'X' ? w : h) - offset - kerf;
    assert(axis === 'X' || axis === 'Y');
    assert(offset > 0 && opposite >= 0 && offset < (axis === 'X' ? w : h));
    if (axis === 'X') {
      available.add([x, y, offset, h].join(','));
      if (opposite) available.add([x + offset + kerf, y, opposite, h].join(','));
    } else {
      available.add([x, y, w, offset].join(','));
      if (opposite) available.add([x, y + offset + kerf, w, opposite].join(','));
    }
  }
  for (const piece of plan.pieces) {
    assert(available.delete(piece.join(',')));
    const dims = piece.slice(2).join(',');
    assert(dims === part.join(',') || (rotate && dims === [...part].reverse().join(',')));
  }
  assert.equal(plan.pieces.length, plan.count);
  assert.equal(plan.waste_area, stock[2] * stock[3] - plan.count * part[0] * part[1]);
}

for (const test of cases) {
  const body = fs.readFileSync('fixtures/' + test.name + '.json');
  const order = JSON.parse(body);
  const coordinate = 'Starling-spell/guillotine-cut-planner/' + proof.source_commit + '/fixtures/' + test.name + '.json';
  const commitment = sha(body);
  const {result: key} = await transaction(test.name, account, 'register_order', [coordinate, commitment]);
  assert.equal(key, commitment);
  const record = await read(proof.address, 'get_order', [key]);
  proof.orders[test.name] = {record};
  save();
  assert.deepEqual(record, {
    url: 'https://raw.githubusercontent.com/' + coordinate, sha256: key, text: body.toString('utf8'),
    part: order.part, orientation: test.orientation,
  });
  const result = await read(proof.address, 'plan', [key, 5, 5, 0]);
  assert.equal(result.orientation, test.orientation);
  assert.equal(result.guaranteed.count, test.count);
  assert.deepEqual(result.guaranteed, result.possible);
  replayPlan(result.guaranteed, [0, 0, 5, 5], order.part, 0, test.orientation === 'ROTATE');
  proof.orders[test.name].plan = result;
  save();
}
proof.verified = true;
save();
console.log('Verified exact work-order contents and independently replayed both cut plans');
