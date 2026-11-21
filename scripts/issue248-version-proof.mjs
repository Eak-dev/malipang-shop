import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// Binds THIS Wrangler invocation to a fresh single-100% provider readback.
// No raw log, credentials or provider response are emitted on failure.
export function verifyVersion(log,provider,prior){
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 if(typeof log!=='string'||typeof prior!=='string'||!uuid.test(prior))throw Error('NO_GO_VERSION_PROOF');
 const lines=log.split(/\r?\n/).filter(line=>line.startsWith('Current Version ID:'));
 if(lines.length!==1||!/^Current Version ID: [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lines[0]))throw Error('NO_GO_VERSION_PROOF');
 const version=lines[0].slice('Current Version ID: '.length),versions=provider?.result?.deployments?.[0]?.versions;
 if(provider?.success!==true||!Array.isArray(versions)||versions.length!==1||versions[0]?.percentage!==100||versions[0]?.version_id!==version||version===prior)throw Error('NO_GO_VERSION_PROOF');
 return version;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [logFile,providerFile,prior]=process.argv.slice(2);console.log(verifyVersion(readFileSync(logFile,'utf8'),JSON.parse(readFileSync(providerFile,'utf8')),prior));}
 catch{console.error('NO_GO_VERSION_PROOF');process.exitCode=1;}
}
