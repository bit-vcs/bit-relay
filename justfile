default:
  just test

test:
  deno task test

dev:
  deno task dev

dev-cf:
  pnpm run dev:cf

deploy:
  pnpm run deploy

deploy-sprites sprite="myapp":
  tools/deploy-sprites.sh {{sprite}}

sprites-logs sprite="myapp":
  sprite -s {{sprite}} exec sh -lc 'tail -n 120 /home/sprite/bit-relay.log'

bench target="http://localhost:8788":
  k6 run --env BASE_URL={{target}} bench/run-all.js

bench-scenario scenario target="http://localhost:8788":
  k6 run --env BASE_URL={{target}} bench/scenarios/{{scenario}}.js

bench-json target="http://localhost:8788":
  mkdir -p bench/results && k6 run --env BASE_URL={{target}} --out json=bench/results/result.json bench/run-all.js
