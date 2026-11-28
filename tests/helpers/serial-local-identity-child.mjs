import {localIdentityStore} from './serial-local-identity.mjs';
const [directory,scope,cut]=process.argv.slice(2);
try{const result=await localIdentityStore(directory,{onCreated(){if(cut==='kill')process.kill(process.pid,'SIGKILL');}}).claim(scope);process.stdout.write(JSON.stringify(result)+'\n');}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
