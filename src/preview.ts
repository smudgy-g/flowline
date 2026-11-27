import { config } from './config.ts';
import { sandbox } from './sandbox.ts';
const item = process.argv[2];

if (!item || !/^\d+(?:-[a-z0-9-]+)?$/.test(item)) throw Error('Invalid preview work item');

console.error(`Preview in fx-${item}. Publish the kit's ports to worker loopback with sbx port. Ctrl-C stops the sandbox.`);
process.once('SIGINT', () => { void sandbox.stop(item).then(()=>process.exit(130)); });
const command = config.commands.preview;

if (!command) throw Error('No commands.preview configured');

const result = await sandbox.exec(item,command,{env:{...config.commands.env,FACTORY_SANDBOX_PREVIEW:'1'},timeoutMinutes:120});
console.error(result.output);
process.exitCode = result.code;
