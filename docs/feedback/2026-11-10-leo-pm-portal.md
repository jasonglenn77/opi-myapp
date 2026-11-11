# PM Portal feedback: Leonardo (PM), 2026-11-10

Received by Jason by email on 2026-11-10. To be worked on when the PM Portal is optimized.
Email templates Leo attached: `references/Email Templates OPI APP - Project Management.pdf` (copied below).

Status key: **open** unless marked.

## Fixes and small changes
1. **Project day count** on the project Overview tab, next to the schedule dates.
2. **Bug:** the Schedule page won't open for him.
3. **Bug:** documents such as drawings won't open from the Documents tab.
4. **Remove the Daily Log page** ("scrap it").
5. **Colors in the drawing markup tool** (Marked Drawings / highlighter):
   - Yellow: standing
   - Blue: structurally complete (all levels installed and anchored)
   - Green: 100% complete (all detail work: wire decks, ERGs, dividers, etc.)
   - Red: red flag (material missing or layout problem)

## 6. Project Lifecycle page (new)
A checklist of the PM's communication steps, each sending an email from a template:

| Step | Template (from the PDF) | Attachments / links |
|---|---|---|
| a. Schedule kickoff call | "Schedule Kickoff Call Email" | — |
| b. Customer kickoff call done + checklist sent | "Customer Kickoff Checklist Email" | Customer Kickoff checklist as PDF; extra attachments allowed |
| c. Crew kickoff call done + checklist sent | "Crew Kickoff Checklist Email" | Crew Kickoff checklist as PDF; extra attachments allowed |
| d. Client project text thread created | — | Start text threads in the app and store every message |
| e. Crew project text thread created | — | Same, for the crew |
| f. Day 1 project kickoff | "Day 1 Kickoff Email" | Link to the project's progress-update folder; extra attachments |
| g. Daily updates | "Daily Updates" | Link to the progress-update folder; extra attachments; **start from the previous day's update so it isn't retyped** |
| h. Project completion | "Project Completion Email" | Link to the completion folder (signed completion form + photo); extra attachments |
| i. Marketing video submission | — | Later, together with the safety form |

**Contact directory needed:** if the app sends email and texts, PMs need a directory of customer and crew contacts so they don't retype emails and phone numbers. (The app already has Contacts from the estimating pipeline; extend it to site contacts and crew bosses/leads.)

Leo asked: once this round is done, is the app ready for **beta testing**?

## Email templates (text of Leo's PDF)
Placeholders in (parentheses).

**Schedule Kickoff Call Email**
Subject: Kickoff Call: (JOB NAME) - (City, State) Quote #0000
> Hello, (Client Name),
> I'm looking forward to working on a (Client's Company Name) Project! Let's schedule a kickoff call so we can be prepared for when the project starts.
> Which of the following date and time works for you:
> - Day of the week, Month Date @ Time & timezone (ex: Tuesday, October 20th @ 12PM CST)
> If none of the following dates above work for you, please let me know a date and time that works best.
> Thank you,

**Customer Kickoff Checklist Email**
Subject: Kickoff Call Recap: (JOB NAME) - (City, State) Quote #0000
> Hello, (Client Name),
> Thank you for taking the time to go over the (Project Name) project. Please see the attached kickoff checklist filled out on the call, we just need confirmation for the following:
> - XYZ (list)
> Feel free to call or text me with any questions or concerns.
> Thank you,

**Crew Kickoff Checklist Email**
Subject: Crew Kickoff Call: (JOB NAME) - (City, State)
> Hello, (Crew Boss),
> Thank you for taking the time to go over the (Project Name) project. Please see the attached kickoff checklist, make sure we pay attention to the following:
> - XYZ (list)
> Feel free to call or text me with any questions or concerns.
> Thank you,

**Day 1 Kickoff Email**
Subject: Project Kickoff: (JOB NAME) - (City, State) Quote #0000
> Hello, (Client Name),
> Please view the following LINK to see the facility before photos.
> We have arrived onsite to kickoff the (Project Name) project. The layout is being marked and trucks are being unloaded, please let me know if you have any questions or concerns.
> Thank you,
> LINK - to the progression update folder for the project.

**Daily Updates**
Subject: Project Update: (JOB NAME) - (City, State) Quote #0000
> Hello, (Client Name),
> Please see the following LINK to view photo and drawing updates.
> 1. Progress Summary: Percentage Complete: 0%
> 2. Current Work: XYZ
> 3. Upcoming Tasks: XYZ
> 4. Issues or Actionable Items: All good.
> Please let me know if you have any questions or concerns.
> Thank you,
> LINK - to the progression update folder for the project.
> *Show the previous project daily update email to be edited, to avoid retyping everything.*

**Project Completion Email**
> Hello, (Client Name),
> Please view the following LINK to see signed completion form & photo.
> We have successfully completed the (Project Name) project in (City, State). Final walkthrough has been completed and received completion form signed by (End User who signed completion form). Looking forward to our next project together.
> Please let me know if you have any questions or concerns.
> Thank you,

## Notes for when this is built
- Email sending needs OPI's SMTP mailbox (prod has none yet); until then, "copy email" + mark step done.
- Text threads need an SMS provider (e.g. Twilio) and a number; that's a cost and setup decision for OPI.
- Kickoff and daily modules already exist (`backend/app/kickoff`, `backend/app/daily`), as do crew forms (kickoff_update, daily_update, completion) whose answers can prefill these emails.
