# Stack pack — Next.js (App Router)

Defaults to reach for in a Next.js App Router codebase. **The target repo's own
patterns win** wherever they differ — read an existing route/component of the
same kind first and match it (constitution Principle III). This is the fallback
when the repo hasn't set a precedent.

> If the Vercel plugin skills are available this session, prefer them for depth
> (`vercel:nextjs`, `vercel:shadcn`, `vercel:react-best-practices`,
> `vercel:next-cache-components`). This pack is the portable, always-present
> baseline.

## Defaults

- **Server Components by default.** Only add `"use client"` when the component
  actually needs interactivity, browser APIs, state, or effects. Push client
  boundaries as far down the tree as possible; keep pages/layouts server.
- **Data fetching happens on the server** — `fetch`/DB calls inside Server
  Components, not in `useEffect`. Colocate the fetch with the component that
  needs it rather than prop-drilling from the page.
- **Mutations go through Server Actions** (`"use server"`), not hand-rolled API
  routes, unless the repo already standardizes on route handlers or the
  endpoint is a public/webhook surface. Revalidate after a mutation
  (`revalidatePath`/`revalidateTag`) instead of manual refetching.
- **Route Handlers** (`app/**/route.ts`) for webhooks, third-party callbacks,
  and non-UI JSON APIs. Validate every input at the boundary (Principle II)
  with the repo's existing validator (often Zod).
- **Async request APIs**: `cookies()`, `headers()`, `params`, and
  `searchParams` are async in current Next.js — `await` them. Reaching for a
  request value opts that segment into dynamic rendering; do it deliberately.
- **Caching is explicit.** Know whether a segment is static or dynamic before
  claiming it's done. If the repo uses Cache Components / `use cache` / PPR,
  follow that model; don't sprinkle `force-dynamic` to make a bug disappear.
- **Metadata** via the `metadata` export / `generateMetadata`, not manual
  `<head>` tags. **Images** via `next/image`, **fonts** via `next/font`,
  **navigation** via `next/link` and `next/navigation`.
- **Server/client env split**: server-only secrets never get a `NEXT_PUBLIC_`
  prefix; only genuinely public values do. Keep secrets out of Client
  Components entirely.

## Where things go

- `app/` — routes, layouts, `loading.tsx`, `error.tsx`, `not-found.tsx`.
- Colocate route-only components/helpers with the route; lift shared UI to the
  repo's existing shared location (`components/`, `ui/`, a `@repo/*` package in
  a monorepo) — match what's already there.
- Server-only modules: mark with `import "server-only"` so they can't leak into
  a client bundle.

## Don't

- Don't add `"use client"` to a whole page to fix one interactive child —
  extract the child instead.
- Don't fetch data in `useEffect` when a Server Component can fetch it directly.
- Don't reach for an API route to do what a Server Action does, if the repo
  favors actions.
- Don't paper over caching/dynamic-rendering surprises with `force-dynamic` or
  `revalidate = 0` without understanding why the segment was static.
- Don't introduce a new data/validation/styling library when the repo already
  has one.

## Verify (before "done")

- `next build` / the repo's build script passes (catches server/client
  boundary and RSC serialization errors that dev hides).
- Typecheck/lint clean.
- The changed route renders and the golden path works — and if you touched a
  mutation, the revalidation actually reflects the change without a hard reload.
- Confirm the segment's static-vs-dynamic behavior is what you intended.
