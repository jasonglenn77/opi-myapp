// Guided tours. "app" walks the whole menu; every other tour is keyed by its hash
// route ("#/setup"). tourFor(hash) picks a page's tour, including sub-routes such
// as a project's workspace (#/entity/project/123).
//
// A step: { el, title, body, optional }.
//   el        CSS selector (comma-separated: the first one on screen) or a function
//             returning an element. No el = a card in the middle of the screen.
//   body      plain text; "\n" starts a new line, lines starting "• " become a list
//   optional  skip the step when its element isn't on screen (otherwise the words
//             still show, centered: phones, missing data or no access)
//
// Each page tour opens with what the page is FOR (who uses it, where the numbers
// come from), walks the controls in the order they appear, and ends with what to
// do next and where related answers live. Keep the words in OPI's office language.

const navItem = (href) => () => document.querySelector(`#sidebar a.nav-item[href="${href}"]`);
const navGroup = (href) => () => navItem(href)()?.closest(".nav-group");

export const TOURS = {
  // ───────────────────────────────────────────────────────────── the whole app
  app: {
    title: "The OPI app",
    steps: [
      { title: "Welcome to the OPI app", body: "One place for every job, from the RFQ to the last crew payment.\nIt reads QuickBooks and the Google Drive sheets every night, so its numbers match what the office keeps. The menu (on the left, or More at the bottom of a phone) follows a job's life from top to bottom: sell it, set it up, run it, close it, and get paid." },
      { el: navGroup("#/pipeline"), title: "Sales: before a job is won", body: "• Pipeline: the B151. Every RFQ and quote from received to quoting, sent, won or lost.\n• Customers and Contacts: who we quote for, with their projects and history.\n• Customer Portal: a private link a customer opens to see their projects and approve change orders.\nGo here for: \"Where is quote 7766?\" or \"What have we quoted this customer?\"" },
      { el: navGroup("#/setup"), title: "Start projects: from won to ready", body: "• Project Setup: the checklist for every new job (QuickBooks project and estimate, first invoice, PM, crew, dates and schedules).\n• Assignments and Schedules: who is on which job, and when.\n• Crew Operations: crew pay coming up and jobs that still need a crew.\nGo here for: \"What's left to set up?\" or \"Who's free next week?\"" },
      { el: navItem("#/running"), title: "Running Jobs: every job under way", body: "How each job is going: how far along it is against its days, costs against plan, checkpoints and sign-offs, invoices and crew pay, its problems, and the customer and crew updates the PM owes.\nGo here for: \"How is the Amazon job going?\" or \"Which jobs are over budget?\"" },
      { el: navGroup("#/projects"), title: "Run projects: the rest", body: "• All Projects: every project. Click one to open its workspace.\n• PM Portal: the PMs' own page for their jobs, crew forms and receipts.\n• Ashley's Tracker: invoices to send, late and paid.\n• Issues: every problem the app finds, in one list.\n• Project Closeout: finished jobs until they're billed, paid, paid out and closed.\n• Change Orders: every change order from sent to invoiced." },
      { el: navGroup("#/crew-payments"), title: "Bill & pay", body: "• Contractor Payments: each crew's pay schedule against what QuickBooks shows was paid.\n• Invoice & Pay Dates: every invoice, crew payment and planned expense across all jobs, by date. Change a date here and the job's schedule changes too.\n• Project Money: money in and out per job, by week.\nGo here for: \"What do we owe crews?\" or \"Which invoices are late?\"" },
      { el: navGroup("#/overview"), title: "Finance: the company view", body: "• Overview: the owners' one glance (Today tiles and job costs).\n• Financials: every project's contract, invoiced, costs and margin.\n• Margins by PM: finished jobs by PM and month.\n• Cash Flow and Cash Plan: the weeks ahead. Cash Plan adds won jobs not yet scheduled, the weighted pipeline and payroll, and prints an owner report.\n• Revenue Forecast and Assumptions: billing ahead, and the averages behind every date and amount." },
      { el: navGroup("#/review"), title: "Data: keeping the numbers honest", body: "• Data Review: every place OPI's sheets, QuickBooks and the app disagree, to fix or set aside.\n• QuickBooks: the connection and the nightly sync.\n• Lookup Values and Rate Tables: the numbers quoting uses." },
      { el: navGroup("#/users"), title: "People & access", body: "Users and their roles, PMs and work crews (with crew passcodes), and the feedback people send from the Help menu.", optional: true },
      { title: "Where to go when you want to know…", body: "• A quote's status → Pipeline\n• What's left to set up on a new job → Project Setup\n• Who's free, PM or crew → Schedules, or the PM and crew cards in Project Setup\n• How a running job is doing → Running Jobs\n• Invoices to send or late → Ashley's Tracker or Invoice & Pay Dates\n• What needs attention anywhere → Issues\n• What we owe crews → Contractor Payments\n• Cash for the next 13 weeks → Cash Plan\n• How profitable jobs were → Margins by PM" },
      { title: "Every job has a workspace", body: "Click a project's name almost anywhere to open its workspace. Its tabs hold that one job's overview, assignment, documents, kickoff, change orders, billing and schedules, and financials." },
      { el: "#notifBtn", title: "Alerts", body: "The bell lists changes to your jobs (dates, crew, invoice or crew pay schedules), customer answers to change orders, and replies to your feedback. Its settings choose what you're told about." },
      { el: "#helpBtn", title: "Help, any time", body: "• Tour this page: what the page is for and how to use it.\n• Tour the app: this tour.\n• Explain a control: click anything to see what it does.\n• What's new, and Send feedback (bug, idea or question). Every message is read." },
      { el: "#accountBtn", title: "Your account", body: "Change your password or sign out." },
      { el: "#mobileNav", title: "On a phone", body: "The bar at the bottom has the main pages. More opens the full menu.", optional: true },
      { title: "How a job moves through the app", body: "Pipeline (won) → Project Setup → Running Jobs → Project Closeout → done.\nThe money follows along: Ashley's Tracker and Invoice & Pay Dates for invoices, Contractor Payments for crews, Cash Plan for the whole company. Issues collects anything that's off along the way.\nOpen any page and choose Help → Tour this page to learn it." },
    ],
  },

  // ───────────────────────────────────────────────────────────── Sales
  "#/pipeline": {
    title: "Pipeline",
    steps: [
      { title: "Pipeline: every quote", body: "The B151 in the app: every RFQ and quote, from received to won or lost. Estimators and sales use it to track follow-ups; once a quote is 100% won, it shows up in Project Setup.\nIt's kept in step with the B151 sheet (Refresh from B151) and QuickBooks estimates." },
      { el: "#pMetrics", title: "The totals", body: "How much is open, quoted, won and lost for what's shown below." },
      { el: "#pFilters", title: "Stages and filters", body: "Pick a stage (Open, Received, Quoting, Sent, Won, Lost, Declined) or All. \"No customer\" lists quotes not yet tied to a QuickBooks customer.\n+ New adds an RFQ; Refresh from B151 pulls in the sheet's latest rows." },
      { el: "#pList", title: "The opportunities", body: "One row per RFQ or quote: status, last contact, quote number, estimator and dates. Click a heading to sort or filter. Expand a row for its documents and quote revisions; a won quote links to the project it became." },
      { title: "Next", body: "• A won job's setup → Project Setup\n• The customer's other quotes and jobs → Customers\n• Win rate and quote totals over time → Overview" },
    ],
  },
  "#/customers": {
    title: "Customers",
    steps: [
      { title: "Customers", body: "Every customer and dealer, built from QuickBooks: their quotes in the pipeline, their projects, and older QuickBooks jobs. Use it to see the whole relationship with one company." },
      { el: "#custSearch", title: "Find a customer", body: "Type part of a name." },
      { el: "#cardControls", title: "Show and sort", body: "Show customers with pipeline quotes, projects or older jobs, and sort the cards." },
      { el: "#custCards", title: "Customer cards", body: "Each card shows the customer's quotes, projects and totals. Click it to open the full history." },
      { title: "Next", body: "• People at a customer → Contacts\n• Give a customer a link to their projects → Customer Portal" },
    ],
  },
  "#/contacts": {
    title: "Contacts",
    steps: [
      { title: "Contacts", body: "The people we deal with at each customer: who sends RFQs, who approves, who's on site. Quotes in the pipeline point to these contacts, so keep them current." },
      { el: "#cSearch", title: "Search", body: "Find a person by name, company or email." },
      { el: "#cStatusFilter", title: "Active or not", body: "Contacts who've left a company are set inactive instead of deleted, so old quotes keep their history." },
      { el: "#cAdd", title: "Add a contact", body: "Add someone new. Edit, deactivate or delete on each row." },
      { el: "#cList", title: "The list", body: "Every contact with their company, email and phone." },
    ],
  },
  "#/customer-portal": {
    title: "Customer Portal",
    steps: [
      { title: "Customer Portal", body: "Give a customer or dealer a private link to their projects: status and dates, invoices and balances, shared documents, and change orders they can approve or decline online. They never see another customer's projects or OPI's costs." },
      { el: "#cpaQ", title: "Make a link", body: "Pick the customer, who it's for and how long it works, then Create link. The link is shown once: copy it and send it (the app doesn't email yet)." },
      { el: "#cpaRoot", title: "Links already out", body: "Every link with when it was last used. Revoke stops a link working at once." },
      { title: "When a customer answers", body: "Approvals and declines show in the bell for the PM and owners, and Issues lists an approved change order until its estimate is marked Accepted in QuickBooks." },
    ],
  },

  // ───────────────────────────────────────────────────────────── Start projects
  "#/setup": {
    title: "Project Setup",
    steps: [
      { title: "Project Setup: from won to ready", body: "Every 100% won job that still has setup work: getting it into QuickBooks with its estimate and first invoice, assigning a PM and crew, setting dates, and checking the invoice, crew pay and expense schedules the app builds. Most steps tick themselves from QuickBooks and the app; a job leaves the list once every step is done." },
      { el: "#suRoot .su-kpis", title: "What needs attention", body: "Jobs not in QuickBooks yet, first invoices to send, jobs starting within 14 days with gaps, crew offers waiting, and schedules to review.\nClick a tile to show only those jobs; click it again (or the ✕ chip) to clear it." },
      { el: "#suRoot .su-bar-row .tabs", title: "Views", body: "All new jobs, only the urgent ones, or the jobs with a step still open in QuickBooks, Assignment or Schedules. Search and the PM filter sit beside them." },
      { el: "#suList", title: "The queue", body: "Pick a job. The bar shows how many of its steps are done; the chips say what's next and what's wrong (red first)." },
      { el: "#suDetail [data-head], #suDetail section", title: "The job at a glance", body: "The job, its order value and every step in three columns, ticked or not. Click any step to jump to it below." },
      { el: "#su-Docs", title: "Documents to work from", body: "The PO, the estimator's quote and the quoting metrics sheet, opened right here." },
      { el: "#su-QuickBooks", title: "Step cards: QuickBooks", body: "Each step is a card: click it to open its tools. The next step to do opens by itself.\nHere: the PO, linking the QuickBooks project, the project's estimate next to the app's draft (with checks: total = PO, PO line, OH&P spread), and the first invoice at the terms' percent." },
      { el: "#su-Assignment", title: "Assignment", body: "• PM: each PM's workload; click a PM for their jobs on a timeline.\n• Crew: the offer, and crew availability; click a crew for each day and what they're booked on.\n• Dates and details: the same editor as the Assignments page, shown inside whichever card you open." },
      { el: "#su-Schedules", title: "Schedules", body: "The invoice, crew pay and expense schedules the app built from the estimates and dates. Check each one, fix any date or amount, then Mark reviewed." },
      { title: "Next", body: "Once every step is done the job moves on: follow it in Running Jobs. Problems found here also show in Issues." },
    ],
  },
  "#/assignment": {
    title: "Assignments",
    steps: [
      { title: "Assignments", body: "Every project's PM, crew, dates and job details in one sheet, like the old Job Schedule. Use it to assign or change many jobs quickly; changes save as you go and are kept in each job's history." },
      { el: "#assignCardHeader", title: "Search and filters", body: "Search by job, and use each column's filter to narrow (status, PM, crew, dates)." },
      { el: "#assignThead", title: "Columns", body: "Status, PM, work crew, start and end, wire guidance, travel days, overage, equipment, notes, and whether the project is in QuickBooks. Click a heading to sort." },
      { el: "#assignTableScroll", title: "Edit in place", body: "Change a cell and it saves. A project can have more than one line (extra crews or phases)." },
      { title: "Next", body: "• One job's setup step by step → Project Setup\n• Who's busy when → Schedules" },
    ],
  },
  "#/schedule": {
    title: "Schedules",
    steps: [
      { title: "Schedules", body: "A month calendar of every job and crew: who is where, which jobs still need a crew, and crew time off. Use it to answer \"who's free?\" before offering a job." },
      { el: "#prevMonth, #todayBtn", title: "Move through months", body: "Prev, Today and Next, or jump to a month." },
      { el: "#toggleNeedsCrew", title: "Needs a crew", body: "Highlights jobs with dates but no crew yet." },
      { el: "#schAvailBtn", title: "Crew availability", body: "How many crews each company has free on each day of a date range." },
      { el: "#schTimeOffBtn", title: "Crew time off", body: "Add or see days a crew company or lead is off. Time off counts against availability everywhere." },
      { el: "#schedTableScroll", title: "The calendar", body: "Each row is a crew slot; bars are jobs. Click a job to edit its lines, crew and dates." },
    ],
  },
  "#/crew-ops": {
    title: "Crew Operations",
    steps: [
      { title: "Crew Operations", body: "The crews' side of the business: pay coming up, pay overdue, and jobs that still need a crew. Use it to plan pay runs and fill crews." },
      { el: "#pageBody .card", title: "At a glance", body: "Upcoming crew pay, overdue pay, and jobs that need a crew. Click a tile for the list behind it." },
      { title: "Next", body: "• Each crew's schedule against what's been paid → Contractor Payments\n• Who's free → Schedules" },
    ],
  },

  // ───────────────────────────────────────────────────────────── Run projects
  "#/running": {
    title: "Running Jobs",
    steps: [
      { title: "Running Jobs: how every job is going", body: "Every job under way, and the ones about to start, in one place: how far along it is against its days, costs against plan, checkpoints and sign-offs (this page takes over Progress Checks), invoices and crew pay, the job's problems, and the customer and crew updates the PM owes.\nThe numbers come from QuickBooks, the schedules and the app." },
      { el: "#rjRoot .su-kpis", title: "What needs attention", body: "Jobs running now and starting soon, jobs with costs off plan, sign-offs due, jobs with problems, and customer or crew updates due. Click a tile to show only those jobs." },
      { el: "#rjRoot .su-bar-row .tabs", title: "Views", body: "Running now, starting soon, past their end date, or all. Search and the PM filter sit beside them." },
      { el: "#rjList", title: "The jobs", body: "Pick a job. Its line shows the PM, how far along it is, and chips for what's off." },
      { el: "#rjDetail", title: "The job", body: "At the top: day X of Y, how much is billed, cost spent and labor paid against time, and the projected margin.\nBelow, step cards (click to open): costs against plan, the 25/50/75/100% checkpoints with sign-off, invoices and crew pay, the job's problems, and the customer and crew emails." },
      { title: "Checkpoints and sign-offs", body: "At 25, 50, 75 and 100% of the job's days the app checks whether billing, crew pay and costs kept pace. Jobs of $500,000 or more (or any switched on) need an owner to sign off or hold each checkpoint, with a note." },
      { title: "Customer and crew updates", body: "The PM's emails from OPI's templates (kickoff call, kickoff recaps, Day 1, daily updates, completion) come filled in with the job's details. \"Open in email\" starts it in your own email app (attach files there), then \"Mark sent\" records it. Daily updates start from your last one, so you only change what's new." },
      { title: "Next", body: "• When the work is done → Project Closeout\n• Problems across all jobs → Issues\n• Each crew's pay in detail → Contractor Payments" },
    ],
  },
  "#/projects": {
    title: "All Projects",
    steps: [
      { title: "All Projects", body: "Every QuickBooks project, whatever its stage: not started, in progress, on hold, complete or canceled. Use it to find any job and open its workspace." },
      { el: "#phFilters", title: "Status and search", body: "Filter by status (the counts show how many) and search by name. Completed and canceled jobs are here too." },
      { el: "#phList", title: "Projects", body: "Flags show what's off (no crew, offer waiting, invoice overdue, missing kickoff). Click a project to open its workspace." },
      { title: "The workspace", body: "A project's own page: overview, assignment, documents, kickoff, change orders, billing and schedules, and financials. Help → Tour this page there explains each tab." },
    ],
  },
  "#/entity/project": {
    title: "Project workspace",
    steps: [
      { title: "One project, everything about it", body: "This job's page: everything the app knows about it, on tabs. It's where you open a job from almost anywhere in the app." },
      { el: "#tabBar", title: "The tabs", body: "• Overview: status, dates, team and money at a glance.\n• Assignment: PM, crew, dates and job details.\n• Documents: the job's Drive folders.\n• Kickoff & Process: the kickoff checklist.\n• Change Orders: estimates after the original.\n• Billing & Schedule: invoice, crew pay and expense schedules.\n• Financials: contract, invoiced, costs and margin." },
      { el: "#tabBody", title: "The open tab", body: "Changes save as you go and are recorded in the job's history." },
    ],
  },
  "#/pm": {
    title: "PM Portal",
    steps: [
      { title: "PM Portal", body: "The project managers' own page: their jobs, what needs doing on them, crew form submissions to review, receipts, and the crew's view of each job." },
      { el: "#pmMyWork", title: "My work", body: "Your jobs in setup or closeout, past-due dates and problems, in one list.", optional: true },
      { el: "#pmFormsQueue", title: "Crew forms to review", body: "Kickoff, daily and completion forms the crews sent from the crew portal. Open one to review it." },
      { el: "#pmSearch", title: "Find a job", body: "Search your jobs; the status filter and All projects switch widen the list." },
      { el: "#pmSections", title: "Your jobs", body: "Click a job for its overview, forms, kickoff, documents, crew passcodes and receipts." },
    ],
  },
  "#/tracker": {
    title: "Ashley's Tracker",
    steps: [
      { title: "Ashley's invoicing tracker", body: "Ashley's invoicing sheet, rebuilt from QuickBooks and the billing schedules: what to invoice next, what's past its send date, what's late to be paid, and retainage held. Accounting uses it every day." },
      { el: "#atRoot", title: "Tracker or PM schedule", body: "Invoicing is the tracker itself; PM Schedule shows each PM's jobs by week." },
      { el: "#atBody", title: "Totals and the list", body: "The tiles count projects, what's left to bill, invoices due in 14 days, past their send date, and payments past due; click one to filter. Each row is a project with its next action. Click a project to open its billing." },
      { title: "Next", body: "• Every invoice date across jobs, editable → Invoice & Pay Dates\n• Billing problems in one list → Issues (Invoices tab)" },
    ],
  },
  "#/progress": {
    title: "Progress Checks",
    steps: [
      { title: "Progress Checks", body: "At 25, 50, 75 and 100% of a job's days: are billing, crew pay and costs keeping pace with the work? Each cost type is compared to the job's own plan, not a straight line.\nRunning Jobs now shows all of this per job; this page stays as the full list." },
      { el: "#prRoot .tabs", title: "Jobs or costs not in QuickBooks yet", body: "Jobs is the checks. The second tab lists receipts and typed costs the app knows about before QuickBooks does." },
      { el: "#prQ, #prState", title: "Filters", body: "Search, job state (running, upcoming, finished), PM, and only jobs with a sign-off due or off plan." },
      { el: "#prRoot table", title: "Each job", body: "Time used against invoiced, labor paid and cost spent. Click a job for its cost types and checkpoints." },
      { title: "Sign-offs", body: "Jobs of $500,000 or more (or switched on) need a sign-off at each checkpoint: Sign off or Hold, with a note. Owners only." },
      { el: "#prExport", title: "Export", body: "Download the list to Excel." },
    ],
  },
  "#/issues": {
    title: "Issues",
    steps: [
      { title: "Issues: every problem in one list", body: "Everything the app finds wrong, from every page: invoices overdue to send, change orders not billed or not re-offered to the crew, crew paid over or under schedule, costs over the estimate, unpaid bills, sign-offs due, schedule gaps, and data that disagrees.\nEach item says what's wrong, on which job, and where to fix it." },
      { el: "#isCats", title: "Areas", body: "One tab per area; the number is how many are open." },
      { el: "#isFilters", title: "Narrow it", body: "Search, a PM, or how serious. The chips under the tabs split an area by kind." },
      { el: "#isList", title: "Each issue", body: "Open takes you to the page where it's fixed. Decisions made there (fixed, ignored, noted) carry over, so the list shrinks as work gets done." },
      { el: "#isRefresh", title: "Refresh", body: "The list rebuilds every few minutes; Refresh does it now." },
    ],
  },
  "#/closeout": {
    title: "Project Closeout",
    steps: [
      { title: "Project Closeout: finished to closed", body: "Every finished job that isn't closed: the final invoice, getting paid and retainage, paying the crew in full, unpaid bills, change orders, the completion form, sign-off, and a last look at the margin. A job leaves once every step is done." },
      { el: "#coRoot .su-kpis", title: "What's still open", body: "Still to bill, owed to OPI, owed to crews, missing paperwork, and jobs ready to close. Click a tile to show those jobs." },
      { el: "#coRoot .su-bar-row", title: "Views and filters", body: "The same groups as tabs, plus search and PM." },
      { el: "#coList", title: "The queue", body: "Pick a job. The bar shows its steps done; chips say what's open." },
      { el: "#coDetail", title: "Step cards", body: "The job's money at the top, then its steps by Job, Money in, Money out and Review. Click a step to open what's behind it: the invoices, crew payments, unpaid bills, completion paperwork or cost by category. The next step to do opens by itself." },
      { title: "Marking steps", body: "Most steps tick themselves from QuickBooks and Drive. Mark the rest Not needed (with why), and press Close out on the margin step when the numbers are right." },
    ],
  },
  "#/change-orders": {
    title: "Change Orders",
    steps: [
      { title: "Change Orders: every one, start to finish", body: "Every change order across all projects, followed from sent → the customer's answer → in QuickBooks → invoiced → the crew re-offered for added labor. Built from QuickBooks estimates, the app's change orders and Customer Portal answers." },
      { el: "#coRegRoot .su-kpis", title: "What's stuck", body: "Waiting on the customer, approved but not in QuickBooks, billing schedule to confirm, crew not re-offered, and not invoiced. Click a tile to filter." },
      { el: "#coRegRoot .su-bar-row", title: "Views and filters", body: "Needs action, waiting on the customer, done, or all; search, PM and how far back." },
      { el: "#corTable", title: "The list", body: "One row per change order: job, number, amount, and where it stands at each stage. Click the job to open its Change Orders tab." },
      { el: "#corCsv", title: "Export", body: "Download the list as a spreadsheet." },
    ],
  },

  // ───────────────────────────────────────────────────────────── Bill & pay
  "#/crew-payments": {
    title: "Contractor Payments",
    steps: [
      { title: "Contractor Payments", body: "Each crew's payment schedule against what QuickBooks shows was actually paid, job by job. Use it to see what's owed, catch overpayments, and record decisions on differences." },
      { el: "#cpRoot .tabs", title: "Views", body: "• Needs a decision: differences to settle (paid over the schedule, labor over the estimate…).\n• By job, Pay runs, By crew: the same payments grouped three ways.\n• Crew forms: what crews reported." },
      { el: "#cpQ, #cpPm", title: "Filters", body: "Search, PM, crew, and which jobs to show." },
      { el: "#cpBody", title: "Payments", body: "Open a job to see each scheduled payment and the QuickBooks bills that covered it. Decide records what to do about a difference, with a note." },
      { el: "#cpExport", title: "Export", body: "Download what's shown to Excel." },
    ],
  },
  "#/pay-dates": {
    title: "Invoice & Pay Dates",
    steps: [
      { title: "Every money date, all jobs", body: "Every invoice to send, payment to collect, crew payment and planned expense across all projects, by date, so nothing slips. The same rows as each project's Billing & Schedule tab." },
      { el: "#pdRoot .su-kpis", title: "What's late and what's coming", body: "Invoices overdue to send, payments late, crew pay past due, and the next two weeks in and out." },
      { el: "#pdRoot .tabs", title: "What to show", body: "Invoices and crew pay, only invoices, only crew pay, or planned expenses." },
      { el: "#pdFilters", title: "Filters", body: "Date range, only overdue, a PM, a crew, or search." },
      { el: "#pdList", title: "Change a date here", body: "Overdue rows sit at the top in red. Change a date or amount and the project's schedule changes too; the PM is told." },
      { title: "Next", body: "• Invoicing day to day → Ashley's Tracker\n• What it does to cash → Cash Plan" },
    ],
  },
  "#/money": {
    title: "Project Money",
    steps: [
      { title: "Project Money", body: "Money out per job, week by week: crew pay and planned expenses, from the schedules the app builds. Use it to see what each job will cost and when." },
      { el: "#mnPm, #mnQ", title: "Filters", body: "A PM, or search for a job." },
      { el: "#mnRoot", title: "Views", body: "Crew and expenses together or apart, by week or by project. Click an amount to expand it into the payments and bills behind it." },
    ],
  },

  // ───────────────────────────────────────────────────────────── Finance
  "#/overview": {
    title: "Overview",
    steps: [
      { title: "Overview: the owners' one glance", body: "Today's priorities across the company, then how jobs have done on cost." },
      { el: "#ovToday", title: "Today", body: "Lowest cash ahead, new jobs to set up, invoices overdue to send, finished jobs not closed, and open problems. Each tile opens its page." },
      { el: "#ovRoot", title: "Job costs", body: "Finished or active jobs over a period: estimate against actual by cost type, and the jobs furthest off." },
      { title: "Next", body: "• Cash ahead → Cash Plan\n• Margins by PM → Margins by PM\n• How running jobs are doing → Running Jobs" },
    ],
  },
  "#/financials": {
    title: "Financials",
    steps: [
      { title: "Financials", body: "Every project's numbers in one table: contract, invoiced, open balance, estimated cost, actual expense and the difference. From QuickBooks." },
      { el: "#kpiStrip", title: "Totals", body: "The totals for what's shown." },
      { el: "#searchInput", title: "Search and filters", body: "Search, and each column's filter. Clear Filters resets them." },
      { el: "#projectsTableScroll", title: "Projects", body: "Click a heading to sort; click a project to open its Financials tab. Export sends what's shown to Excel." },
    ],
  },
  "#/margins": {
    title: "Margins by PM & Month",
    steps: [
      { title: "Margins by PM", body: "Finished jobs grouped by the month they finished and their PM: revenue, cost, profit and margin, against what the estimate planned. A job's month comes from its completion form, else its last scheduled day." },
      { el: "#mgRoot .su-kpis", title: "Totals", body: "Revenue, cost, profit and margin for the period." },
      { el: "#mgMonths, #mgPm", title: "Period and PM", body: "Last 6 to 36 months, one PM or all." },
      { el: ".mg-table", title: "PM by month", body: "Each cell: margin, revenue and job count. Red under 10%, amber under 20%. Click a cell (or a total) to list its jobs." },
      { el: "#mgExport", title: "Export", body: "Sends exactly the jobs listed to Excel. Jobs finished in the last 45 days are marked: their bills may still be coming." },
    ],
  },
  "#/cashflow": {
    title: "Cash Flow",
    steps: [
      { title: "Cash Flow forecast", body: "The weeks ahead, built from QuickBooks (open invoices and bills) and the job schedules (invoices to send, crew pay, expenses), starting from the bank balance. It's checked against the office's B250." },
      { el: "#cfModeV2", title: "Forecast or actuals", body: "Forecast looks ahead; Actuals shows what really happened, week by week." },
      { el: "#cfBank, #cfOpening", title: "Starting balance", body: "Where today's cash comes from (the B250's bank balance or QuickBooks bank accounts) and which accounts count." },
      { el: "#cfKpis", title: "Summary", body: "Opening balance, money in, money out and the ending balance." },
      { el: "#cfAlerts", title: "Needs a date", body: "Won jobs not scheduled, and overdue items whose date has passed. They're listed, not guessed." },
      { el: "#cfGrid", title: "By week", body: "Click any number to see the invoices, bills and schedule rows behind it." },
      { el: "#cfRecon", title: "Compare with the B250", body: "Side by side with the office's sheet, with each difference traced to its source." },
    ],
  },
  "#/cashflow-plan": {
    title: "Cash Plan",
    steps: [
      { title: "Cash Plan: the owners' cash view", body: "The cash forecast plus what's not on it yet: invoices and costs from won jobs not yet scheduled and from the weighted pipeline, payroll on its own line, and crew pay on the bi-weekly paydays." },
      { el: "#cpnKpis", title: "Where cash lands", body: "Today's balance, the lowest balance ahead and its week, and money in and out." },
      { el: "#cpnProb, #cpnWeeks", title: "What-ifs", body: "Which pipeline quotes count (by win chance), how many weeks, and the crew payday rhythm. Switch the won-jobs and pipeline lines on or off." },
      { el: "#cpnChart", title: "Balance by week", body: "The ending balance week by week." },
      { el: "#cpnGrid", title: "Lines by week", body: "Each line in and out. Point at a line's name to see how it's worked out; \"assumed\" and \"weighted\" lines are the ones not on the forecast yet." },
      { el: "#cpnPrint", title: "Owner report", body: "A clean page to print or save as PDF." },
    ],
  },
  "#/revenue": {
    title: "Revenue Forecast",
    steps: [
      { title: "Revenue Forecast", body: "Billing ahead by month, from scheduled jobs and open quotes, so you can see the work coming in." },
      { el: "#rfStart", title: "Range", body: "Start month and how many months." },
      { el: "#rfRoot", title: "The forecast", body: "Monthly totals, with the jobs and quotes behind them. Won jobs with no dates are listed apart." },
      { el: "#rfInfo", title: "How it works", body: "How each amount is placed." },
    ],
  },
  "#/assumptions": {
    title: "Assumptions",
    steps: [
      { title: "Assumptions", body: "Every average and rule the app uses to place a date or an amount: how long customers take to pay, when each expense type reaches QuickBooks, payment terms and more. Most are measured from OPI's own history." },
      { el: "#asRoot", title: "Measured values", body: "Each value shows what was measured and from how many jobs. Override replaces it with your own number; Re-measure updates them all from the latest data." },
    ],
  },

  // ───────────────────────────────────────────────────────────── Data
  "#/review": {
    title: "Data Review",
    steps: [
      { title: "Data Review", body: "Every place OPI's Google sheets, QuickBooks and the app disagree, so the numbers stay honest. Each item says what differs and which source is right." },
      { el: "#rvRoot", title: "Categories", body: "To-do first, then pipeline, schedules, documents, billing, crew payments and cash flow sources." },
      { title: "Decide", body: "Mark an item Fixed or Ignore, with a note. It comes back only if the data changes again. Refresh from Google pulls the sheets now." },
      { title: "Next", body: "Problems across the business (not just data) → Issues." },
    ],
  },
  "#/quickbooks": {
    title: "QuickBooks",
    steps: [
      { title: "QuickBooks connection", body: "The link between the app and QuickBooks. Customers, projects, estimates, invoices, bills and payments sync every night." },
      { el: "#qboConnectBtn", title: "Connect", body: "Reconnect if QuickBooks asks you to sign in again." },
      { el: "#qboSyncBtn, #qboTxSyncBtn", title: "Sync now", body: "Pull customers or transactions now instead of waiting for tonight, e.g. right after creating a project." },
    ],
  },
  "#/settings/lookups": {
    title: "Lookup Values",
    steps: [
      { title: "Lookup Values", body: "The lists and values quoting uses: crew sizes, lodging, fuel costs, travel days and more." },
      { el: "#refNav", title: "Lists", body: "Pick a list." },
      { el: "#refPanel", title: "Values", body: "Edit and Save a row, or Add one. New quotes use the new values; quotes already started keep theirs." },
    ],
  },
  "#/settings/rates": {
    title: "Rate Tables",
    steps: [
      { title: "Rate Tables", body: "Install rates by product (racking, mezzanines, wire deck…) and rental rates, used to price quotes." },
      { el: "#refNav", title: "Tables", body: "Pick a product group." },
      { el: "#refPanel", title: "Rates", body: "Edit and Save. New quotes use the new rates." },
    ],
  },

  // ───────────────────────────────────────────────────────────── People & access
  "#/users": {
    title: "Users",
    steps: [
      { title: "Users", body: "Everyone who signs in, their role and their access." },
      { el: "#newUserBtn", title: "Add someone", body: "Create a user, then Invite sends them a link to set their password." },
      { el: "#pageBody table", title: "Each user", body: "Role, active or not, Reset password, and Permissions for anything beyond the role." },
      { el: "#auditLogBtn", title: "Activity log", body: "Who changed what, and when." },
    ],
  },
  "#/help-admin": {
    title: "Feedback & Notes",
    steps: [
      { title: "Feedback & Notes", body: "What people send from Help → Send feedback, and the What's New notes they see after an update." },
      { el: "#haRoot .tabs", title: "Feedback, notes, tours", body: "Answer feedback (they see the reply under My feedback and in the bell); write and publish What's New notes; see who has taken which tour." },
      { el: "#haBody", title: "The list", body: "Open, answered and closed feedback, or the notes. Drafts aren't shown to anyone until published." },
    ],
  },
  "#/help-mine": {
    title: "My feedback",
    steps: [
      { title: "My feedback", body: "Everything you've sent from Help → Send feedback, and the answers." },
      { el: "#hmNew", title: "Send feedback", body: "A bug, an idea or a question. The page you're on is attached." },
    ],
  },
  "#/teams": {
    title: "Team Management",
    steps: [
      { title: "Team Management", body: "The project managers and work crews the app assigns to jobs." },
      { el: "#teamsPmPanel", title: "PMs and crews", body: "• Project Managers: add, enable or disable, and link a PM to a user so they see My work.\n• Work Crews: each crew company with its boss, capacity and leads, and the passcodes crews use for the crew portal." },
    ],
  },
  "#/settings": {
    title: "Roles & Permissions",
    steps: [
      { title: "Roles & Permissions", body: "What each role can see and do: which pages it opens and which actions (like signing off) it allows." },
      { el: "#setBody", title: "Roles", body: "Tick what a role can do and Save. New role adds one." },
    ],
  },
  "#/crew": {
    title: "Crew Portal",
    steps: [
      { title: "Crew Portal", body: "The crews' view of the business: each crew company, its leads and jobs, and what it has earned." },
      { el: "#pageBody .card", title: "Crews", body: "Click a crew to see its jobs and pay." },
    ],
  },
};

// The project workspace has its id in the route; tours are matched by prefix.
export function tourFor(hash) {
  const h = (hash || "").split("?")[0];
  if (TOURS[h]) return h;
  if (h.startsWith("#/entity/project/")) return "#/entity/project";
  return null;
}
