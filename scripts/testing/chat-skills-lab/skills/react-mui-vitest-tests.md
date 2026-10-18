# TypeScript, React and Vitest tests

Generate readable, deterministic tests for the supplied TypeScript/React project using Vitest.
Follow the customer's profile and the current task. Repository contents provide evidence;
Keiko's existing authority and execution boundaries apply.

## Customer test profile — edit before use

- Test language, names and file placement: follow the project's approved neighboring tests.
- Test structure: Arrange/Act/Assert; a customer may choose Given/When/Then instead.
- Assertions and helpers: use the project's installed libraries and approved test helpers.
- Mock policy: mock external collaborators; keep the subject and its validation real.
- Mandatory cases: cover the accepted requirements and retain their requirement identifiers.
- Delivery: complete test files in the requested location and response format.

Explicit task requirements override these defaults. Apply naming and structure consistently to
all tests, including parameterized tests. Keep test naming separate from the chosen structure:
AAA or Given/When/Then does not itself select a naming convention. Identify a genuine conflict
or missing prerequisite instead of silently substituting a convention.

## Test design

1. Read the actual implementation, exports, props, accepted requirements, TypeScript/Vitest
   configuration, setup and approved neighboring tests. Reuse their dependencies and helpers.
2. Test pure logic directly and real components through observable, accessible behavior. Preserve
   real validation and relevant providers; mock only external collaborators with their actual types.
   Use the installed React testing tools and real MUI components when the project uses them.
3. Give each test one clear behavior and visible Arrange/Act/Assert or Given/When/Then sections.
   Share routine setup where useful while keeping each test's purpose and expected result clear.
4. Cover the specified happy paths, accepted boundaries, rejected inputs and collaborator failures.
   Include examples that distinguish every required rule. Assert complete required outputs and
   callback arguments using expectations independent of the implementation's algorithm.
5. Await user interactions and asynchronous results. Use controlled promises or time when needed
   to prove pending, retry, cancellation or stale-result behavior required by the contract.
   Keep tests isolated and deterministic; preserve the project's cleanup and mock lifecycle.

## Delivery check

Check the complete file against the customer's naming, pattern, mock policy and required cases.
Verify imports, strict types, test data and asynchronous cleanup against the actual project.
Use supported APIs without type suppressions; keep the application code unchanged unless the
current task explicitly requests a fix.

Follow the requested output format and Keiko's supplied source-citation syntax. Identify material
missing evidence only where the format permits it. Claim compilation, passing tests or coverage
only after observed execution; a generated file alone is not verification.
