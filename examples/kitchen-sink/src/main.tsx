import { run } from '@natui/core';
import { App } from './App.js';

await run(<App />, {
  title: 'NatUI kitchen sink',
  width: 900,
  height: 640,
  minWidth: 760,
  minHeight: 520,
});
