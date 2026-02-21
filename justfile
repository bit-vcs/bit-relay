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
