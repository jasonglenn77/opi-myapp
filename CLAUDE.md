# OPI app

FastAPI + MySQL backend (`backend/app`), vanilla JS + Tailwind frontend (`frontend/src`).

## Frontend styling

Read [UI-STYLE.md](UI-STYLE.md) before building or restyling any page. The page
background is dark and content sits in white cards. Style each element for the
surface it's on, and reuse the shared tabs, buttons, inputs and chips.

Prod serves `frontend/src/output.css` exactly as committed; the deploy doesn't build
CSS. After changing `frontend/src/styles.css` or using a Tailwind class for the first
time, rebuild it (`cd frontend && npm run build:css`) and commit `src/output.css` in
the same commit, or the new styles silently don't exist on prod.
