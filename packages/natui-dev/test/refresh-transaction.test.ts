import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardRef, memo } from 'react';
import {
  beginRefreshTransaction,
  installRefreshRuntime,
  refreshRuntime,
  refreshRuntimeFacade,
} from '../src/refresh.js';

installRefreshRuntime();

const facade = refreshRuntimeFacade;

test('refresh transaction rolls memo families back recursively', () => {
  const id = 'natui/test/transaction-memo';
  function InnerV1() {
    return null;
  }
  function InnerV2() {
    return null;
  }
  const MemoV1 = memo(InnerV1);
  const MemoV2 = memo(InnerV2);

  refreshRuntime.register(MemoV1, id);
  const transaction = beginRefreshTransaction();
  transaction.run(() => facade.register(MemoV2, id));
  transaction.apply();
  refreshRuntime.performReactRefresh();

  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, MemoV2);
  assert.strictEqual(refreshRuntime.getFamilyByID(`${id}$type`)?.current, InnerV2);

  transaction.rollback();
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, MemoV1);
  assert.strictEqual(refreshRuntime.getFamilyByID(`${id}$type`)?.current, InnerV1);
});

test('refresh transaction rolls forwardRef families back recursively', () => {
  const id = 'natui/test/transaction-forward-ref';
  const RenderV1 = () => null;
  const RenderV2 = () => null;
  const ForwardV1 = forwardRef(RenderV1);
  const ForwardV2 = forwardRef(RenderV2);

  refreshRuntime.register(ForwardV1, id);
  const transaction = beginRefreshTransaction();
  transaction.run(() => facade.register(ForwardV2, id));
  transaction.apply();
  refreshRuntime.performReactRefresh();

  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, ForwardV2);
  assert.strictEqual(refreshRuntime.getFamilyByID(`${id}$render`)?.current, RenderV2);

  transaction.rollback();
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, ForwardV1);
  assert.strictEqual(refreshRuntime.getFamilyByID(`${id}$render`)?.current, RenderV1);
});

test('concurrent async refresh transactions keep registrations isolated', async () => {
  const idA = 'natui/test/transaction-concurrent-a';
  const idB = 'natui/test/transaction-concurrent-b';
  function A1() {
    return null;
  }
  function A2() {
    return null;
  }
  function B1() {
    return null;
  }
  function B2() {
    return null;
  }

  refreshRuntime.register(A1, idA);
  refreshRuntime.register(B1, idB);
  const transactionA = beginRefreshTransaction();
  const transactionB = beginRefreshTransaction();
  let releaseA!: () => void;
  const waitForB = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const taskA = transactionA.run(async () => {
    await waitForB;
    facade.register(A2, idA);
  });
  const taskB = transactionB.run(async () => {
    facade.register(B2, idB);
    releaseA();
  });
  await Promise.all([taskA, taskB]);

  transactionA.apply();
  transactionB.apply();
  refreshRuntime.performReactRefresh();
  assert.strictEqual(refreshRuntime.getFamilyByID(idA)?.current, A2);
  assert.strictEqual(refreshRuntime.getFamilyByID(idB)?.current, B2);

  transactionA.rollback();
  transactionB.commit();
  assert.strictEqual(refreshRuntime.getFamilyByID(idA)?.current, A1);
  assert.strictEqual(refreshRuntime.getFamilyByID(idB)?.current, B2);
});

test('a rolled-back async transaction ignores late registrations', async () => {
  const id = 'natui/test/transaction-late-registration';
  function Current() {
    return null;
  }
  function Stale() {
    return null;
  }

  refreshRuntime.register(Current, id);
  const transaction = beginRefreshTransaction();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluation = transaction.run(async () => {
    await gate;
    facade.register(Stale, id);
  });

  transaction.rollback();
  release();
  await evaluation;
  transaction.apply();
  refreshRuntime.performReactRefresh();

  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Current);
});

test('a committed async transaction publishes late registrations', async () => {
  const id = 'natui/test/transaction-late-committed-registration';
  function Current() {
    return null;
  }
  function Late() {
    return null;
  }

  refreshRuntime.register(Current, id);
  const transaction = beginRefreshTransaction();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluation = transaction.run(async () => {
    await gate;
    facade.register(Late, id);
  });

  transaction.apply();
  transaction.commit();
  release();
  await evaluation;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Late);
});

test('rollback discards registrations that arrive after apply', async () => {
  const id = 'natui/test/transaction-applied-then-rolled-back';
  function Current() {
    return null;
  }
  function Stale() {
    return null;
  }

  refreshRuntime.register(Current, id);
  const transaction = beginRefreshTransaction();
  transaction.apply();
  transaction.run(() => facade.register(Stale, id));
  transaction.rollback();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Current);
});

test('commit publishes registrations that arrive after apply', async () => {
  const id = 'natui/test/transaction-applied-then-committed';
  function Current() {
    return null;
  }
  function Late() {
    return null;
  }

  refreshRuntime.register(Current, id);
  const transaction = beginRefreshTransaction();
  transaction.apply();
  transaction.run(() => facade.register(Late, id));
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Current);

  transaction.commit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Late);
});

test('a paused committed transaction buffers registrations until resume', async () => {
  const id = 'natui/test/transaction-paused-then-resumed';
  function Current() {
    return null;
  }
  function Late() {
    return null;
  }

  refreshRuntime.register(Current, id);
  const transaction = beginRefreshTransaction();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluation = transaction.run(async () => {
    await gate;
    facade.register(Late, id);
  });
  transaction.apply();
  transaction.commit();
  transaction.pause();

  release();
  await evaluation;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Current);

  transaction.resume();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, Late);
});

test('retiring an old transaction quarantines its late registrations', async () => {
  const id = 'natui/test/transaction-retired-after-replacement';
  function OldCurrent() {
    return null;
  }
  function OldLate() {
    return null;
  }
  function NewCurrent() {
    return null;
  }

  refreshRuntime.register(OldCurrent, id);
  const oldTransaction = beginRefreshTransaction();
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldEvaluation = oldTransaction.run(async () => {
    await oldGate;
    facade.register(OldLate, id);
  });
  oldTransaction.apply();
  oldTransaction.commit();
  oldTransaction.pause();

  const newTransaction = beginRefreshTransaction();
  newTransaction.run(() => facade.register(NewCurrent, id));
  newTransaction.apply();
  refreshRuntime.performReactRefresh();
  newTransaction.commit();
  oldTransaction.retire();

  releaseOld();
  await oldEvaluation;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(refreshRuntime.getFamilyByID(id)?.current, NewCurrent);
});
