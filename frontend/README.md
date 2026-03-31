## Frontend

This is the Next.js frontend for OmniMind.

## Getting started

Install dependencies and run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

This app expects the backend API to be running on `http://localhost:8000` by default.

To override that, create `frontend/.env.local` with:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

The main app entry is `src/app/page.tsx`.

## Scripts

- `npm run dev`: start the dev server
- `npm run build`: create a production build
- `npm run start`: run the production build
- `npm run lint`: run ESLint

## Full app startup

For full-stack setup and startup instructions, use the root [README](/Users/charinpatel/workspace/projects/omni-mind/README.md).
