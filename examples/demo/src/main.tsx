import { run } from 'natui';
import { App } from './App.js';

await run(<App />, {
  title: 'natui demo',
  width: 480,
  height: 620,
  minWidth: 380,
  minHeight: 420,
});

console.error('[demo] mounted');
