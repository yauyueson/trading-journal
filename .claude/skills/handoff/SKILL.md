---
name: handoff
description: Read .handoff/current.md and act on it based on your Executor role — implement, review, or respond to what's assigned to you
user_invocable: true
---

# Handoff Protocol

When the user invokes `/handoff`, follow this protocol:

## Step 1: Check for active handoff

Read `.handoff/current.md`. If it does not exist, tell the user:
> "No active handoff. To start one, ask Gemini to write a plan to `.handoff/current.md`, or create one yourself."

## Step 2: Check ownership

Read the YAML frontmatter. If `owner` is NOT `claude`:
> "This task is owned by **[owner]**. I should not act on it. Tell [owner] to complete their work first, or reassign it to me by changing `owner: claude` in the frontmatter."

## Step 3: Act based on stage

**If `stage: review`:**
- Read the full Objective, Context, and Work Done sections
- Validate the plan/analysis against the actual codebase
- If the plan is sound: update `stage: building`, `owner: claude`, append your review to Work Done
- If there are issues: update `stage: blocked`, `owner: gemini`, explain concerns in Work Done

**If `stage: building`:**
- Read the full Objective, Context, and Work Done sections
- Implement what's described
- When done: update `stage: done`, summarize in Work Done, list files in Artifacts

**If `stage: thinking`:**
- This should be Gemini's job. Tell the user:
> "This task is in the thinking stage — that's Gemini's role. Ask Gemini to work on it first."

**If `stage: blocked`:**
- Read the blocker explanation in Work Done
- If you can unblock it, do so and update the stage
- If not, explain what's needed to the user

**If `stage: done`:**
> "This task is already done. Move it to `.handoff/history/` with: `mv .handoff/current.md .handoff/history/YYYY-MM-DD-<description>.md`"

## Step 4: Update current.md

After any action, always:
1. Update the YAML frontmatter (`stage`, `owner`, `from: claude`, `timestamp`)
2. Replace the summary paragraph in Work Done with current state
3. Append your work to the chronological log
4. Update Artifacts with any files you created/modified
5. Set Next Action for whoever comes next
