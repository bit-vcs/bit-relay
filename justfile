default:
  just test

test:
  deno task test

dev:
  deno task dev

mcp:
  deno task mcp

dev-cf:
  pnpm run dev:cf

deploy:
  pnpm run deploy

deploy-sprites sprite="myapp":
  tools/deploy-sprites.sh {{sprite}}

sprites-logs sprite="myapp":
  sprite -s {{sprite}} exec sh -lc 'tail -n 120 /home/sprite/bit-relay.log'

deploy-exe host:
  tools/deploy-exe.sh {{host}}

exe-logs host:
  ssh {{host}} 'tail -n 120 ~/bit-relay.log'

test-serve target="http://localhost:8788":
  tools/test-serve-flow.sh {{target}}

test-claim-watch target="http://localhost:8788":
  tools/test-claim-watch.sh {{target}}

test-5agents target="http://localhost:8788":
  tools/test-5agents-claim.sh {{target}}

bench target="http://localhost:8788":
  k6 run --env BASE_URL={{target}} bench/run-all.js

bench-scenario scenario target="http://localhost:8788":
  k6 run --env BASE_URL={{target}} bench/scenarios/{{scenario}}.js

bench-json target="http://localhost:8788":
  mkdir -p bench/results && k6 run --env BASE_URL={{target}} --out json=bench/results/result.json bench/run-all.js
