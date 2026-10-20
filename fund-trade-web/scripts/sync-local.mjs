// Refresh fund-trade-web/local/ from the workspace copies.
import { syncLocalSources } from './local-bundle.mjs';
import { WORKSPACE_ROOT } from './site-files.mjs';

const result = await syncLocalSources({ workspace: WORKSPACE_ROOT });
console.log(`Local bundle: ${result.directory}`);
console.log(`Updated: ${result.updated.length ? result.updated.join(', ') : 'none'}`);
if (result.kept.length) console.log(`Sources missing, kept existing: ${result.kept.join(', ')}`);
