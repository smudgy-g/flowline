# Project skill packs

A pack is a directory of named skills (`name/SKILL.md`). List packs in `.factory/config.json` under `skills.packs`: a bare name is one of the factory's own (`core`), a path is one of your project's. They are copied to each task's `.agents/skills/`.

Keep `skills/core` for the built-in planning and review roles. `skills/typescript` is optional. Teams can add their own language, framework or domain packs without changing the workflow. Use unique skill names across packs.

`skills.coder.always` lists skills for every coder call. `skills.coder.areas` maps an area name to `{ "paths": ["api/**"], "skills": ["your-api-skill"] }`; paths mentioned by the plan or touched by the task select extra skills. `skills.codeReviewers` names the additional standard-lane reviewers.
