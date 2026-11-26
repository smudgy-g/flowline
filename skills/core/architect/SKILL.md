---
name: architect
description: Design high-impact code shapes before implementation. Use for cross-module APIs, ownership or layering changes, domain models, concurrency, shared state, or hard-to-reverse interfaces. Do not use for local implementation details or routine functions.
---

# Architect

Settle caller usage, types, ownership, and module boundaries before implementation.

## Trigger

Use when work changes one or more of:

- public or cross-module API
- ownership or layering
- domain model or state machine
- concurrent or shared mutable state
- persistent schema or external contract
- interface expensive to reverse

Skip for local helpers, mechanical migrations with established shape, and routine functions.

## Process

1. Trace current callers, data flow, types, and ownership. Read relevant ADRs and domain context.
2. Write intended caller usage first.
3. Name authoritative data shape and invariants.
4. Produce two structurally distinct options when decision is novel. One option may be “keep current shape.”
5. Compare options on:
   - correctness and illegal states
   - ownership and coupling
   - public surface versus hidden complexity
   - migration cost and reversibility
   - verification path
6. Choose smallest deep interface consistent with repository architecture.
7. Sketch signatures, types, module map, and migration order. Bodies may be pseudocode.
8. Verify sketch against real callers. If implementation later needs repeated casts, optional fields always populated, duplicated branches, or caller knowledge of internals, stop and redesign.

## Output

Return:

- current flow with `file:line` evidence
- caller usage sketch
- types and signatures
- module ownership
- alternatives rejected and concrete reason
- migration and verification plan
- open product decisions only

Do not implement unless caller requested implementation. Do not create compatibility layers unless rollout requires them.
