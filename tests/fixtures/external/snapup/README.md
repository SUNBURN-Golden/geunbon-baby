# Synthetic Snapup diagnostic reproductions

These fixtures are written for this regression suite. They are **not captured
Snapup markup**, and their paths and CSS classes do not establish a public
Snapup product schema or justify a source-specific extractor.

`heading-collapse.html` puts five in-scope labels under a generic `main` heading.
With the shipped `selector: "main"`, the generic parser selects one candidate,
uses the heading as its title, and rejects it as `not_baby_item`. Selecting the
synthetic `.card` scopes in a test demonstrates that the unchanged classifier
accepts those product labels even without prices, schedules or inferred model
categories. This test-only selector is not a proposed production configuration.

`contamination.html` puts diaper/formula navigation and a neighboring excluded
product beside a stroller. `main` merges their text and gives one
`excluded_category` rejection. The `.card` comparison isolates the stroller
from the excluded neighbor. Neither result proves which condition occurred in
production on November 4.

No original page, credential, real seller, user content, embedded application
state, price or endpoint was retained. The older `../snapup.html` table fixture
is also synthetic; it tests heuristics with an empty selector, not the active
`main` discovery policy.
