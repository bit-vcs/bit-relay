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
