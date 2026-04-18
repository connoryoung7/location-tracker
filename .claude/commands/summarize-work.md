___
description: Summarize local branch work versus main
allowed-tools: Bash(git branch --show-current), Bash(git diff *), Bash(git log *), Bash(git status *)
---

Current branch: !`git branch --show-current`
Status: !`git status --short`

Changed files:
!`git diff --name-status main...HEAD`

Diff summary:
!`git diff --stat main...HEAD`

Commits:
!`git log --oneline --decorate main..HEAD`

Task:
Summarize the work on this branch versus `main`, grouping related changes, summarizing each commit, noting user/developer impact, and drafting a PR summary.
