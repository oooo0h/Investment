import path from 'node:path';

// Site previews, test artifacts and logs share the workspace's ignored folder.
export function siteTemporaryPath(root, ...segments) {
  const site = path.resolve(root);
  return path.join(path.dirname(site), '临时文件', path.basename(site), ...segments);
}
