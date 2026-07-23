import { run } from 'natui';
import { App } from './App.js';

await run(<App />, {
  title: 'natui kitchen sink',
  width: 900,
  height: 640,
  minWidth: 760,
  minHeight: 520,
});
