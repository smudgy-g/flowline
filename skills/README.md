# Skills

The agents' skills, in packs: one folder per framework or concern. `factory.config.json` picks the packs a project
uses, and the factory copies every skill in them into each task's worktree (`.agents/skills/`, kept out of git).

| Pack | What's in it |
|---|---|
| `core/` | What the lane itself needs, for any project: the plan, design and code reviewers, `ponytail` |
| `typescript/` | `typescript-guidance`, a standard-lane code reviewer |
| `nuxt/` | Nuxt/Vue coder skills: components, composables, server routes, tests (Vitest) |

For another framework, add a pack (e.g. `skills/rails/`) with a `SKILL.md` per skill, and name it in the config:

```jsonc
"skills": {
  "packs": ["skills/core", "skills/rails"],
  "coder": {
    "always": ["ponytail", "write-tests"],          // every coder call
    "areas": {                                     // a call touching one of `paths` (globs) gets `skills`
      "models": { "paths": ["app/models/**"], "skills": ["write-model"] },
      "controllers": { "paths": ["app/controllers/**"], "skills": ["write-controller"] }
    }
  },
  "codeReviewers": ["architect", "interrogate", "change-impact"]   // the standard lane's extra code reviewers
}
```

A project can also keep its own skills in its repo's `.agents/skills/`; the packs are copied in beside them. Every
skill the config names must exist in a pack or the project, or the coder (or the standard lane's skill check) stops.
