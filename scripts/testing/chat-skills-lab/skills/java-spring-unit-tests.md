# Java and Spring Boot unit tests

Generate readable, deterministic unit tests for the supplied Java/Spring Boot project.
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
all tests, including parameterized tests. Keep method naming separate from the chosen structure:
AAA or Given/When/Then does not itself select camelCase or snake_case. Identify a genuine conflict
or missing prerequisite instead of silently substituting a convention.

## Test design

1. Read the actual implementation, interfaces, accepted requirements, build configuration and
   approved neighboring tests. Use their signatures, dependencies, naming and assertions.
2. Choose the smallest test scope that proves the behavior. Instantiate a service directly for
   unit tests; mock only its collaborators. Use a Spring context only when the requested behavior
   needs framework integration, and label that scope accurately.
3. Give each test one clear behavior and visible Arrange/Act/Assert or Given/When/Then sections.
   Share routine setup where useful while keeping each test's purpose and expected result clear.
4. Cover the specified happy paths, accepted boundaries, rejected inputs and collaborator failures.
   Include examples that distinguish every required rule. Derive expected results independently
   from the requirements; copying the implementation's algorithm cannot establish correctness.
5. Assert complete required results and meaningful collaborator arguments, absence or call counts.
   Control time and other external state. Keep tests isolated and deterministic.

## Delivery check

Check the complete file against the customer's naming, pattern, mock policy and required cases.
Verify imports, signatures, test data and setup against the actual project. Use supported APIs;
keep the application code unchanged unless the task explicitly requests a fix.

Follow the requested output format and Keiko's supplied source-citation syntax. Identify material
missing evidence only where the format permits it. Claim compilation, passing tests or coverage
only after observed execution; a generated file alone is not verification.
