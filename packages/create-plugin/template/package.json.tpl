{
  "name": {{pkgNameJson}},
  "version": "0.1.0",
  "description": "{{description}}",
  "license": "MIT",
{{authorJsonLine}}  "type": "module",
  "main": "./dist/index.mjs",
  "exports": {
    ".": "./dist/index.mjs",
    "./package.json": "./package.json"
  },
  "keywords": [
    "sisyphus-plugin"
  ],
  "sisyphus": {
    "id": "{{pluginId}}",
    "displayName": "{{displayName}}",
    "version": "0.1.0",
    "dependencies": [],
    "contributes": {
      "agents": ["{{pluginId}}.agent.hello"],
      "views": [],
      "cards": [],
      "skills": ["{{pluginId}}.skill.echo"]
    }
  },
  "files": [
    "dist",
    "src",
    "README.md"
  ],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "node build.mjs",
    "prepublishOnly": "pnpm build || npm run build"
  },
  "peerDependencies": {
    "@sisylabs/kernel": "^0.1.0"
  },
  "devDependencies": {
    "@sisylabs/kernel": "^0.1.0",
    "@types/node": "^20",
    "esbuild": "^0.28.0",
    "typescript": "^5"
  },
  "publishConfig": {
    "access": "public"
  }
}
