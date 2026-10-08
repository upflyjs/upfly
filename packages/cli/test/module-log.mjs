// Loaded with `node --import` to see which modules a run loads: the address of each module
// loaded as an ES module is appended to the file named by UPFLY_MODULE_LOG, by load hooks
// that run beside the program.
import { register } from 'node:module';

register('./module-log-hooks.mjs', import.meta.url, {
  data: { log: process.env.UPFLY_MODULE_LOG },
});
