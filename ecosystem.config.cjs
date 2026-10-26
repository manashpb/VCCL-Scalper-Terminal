module.exports = { apps: [{ name: 'scalper-terminal', cwd: __dirname, script: 'server/index.mjs', node_args: '--env-file=.env', instances: 1, exec_mode: 'fork', autorestart: true, time: true }] };
