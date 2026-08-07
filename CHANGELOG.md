# [1.7.0](https://github.com/territorial-dev/ordo/compare/v1.6.0...v1.7.0) (2026-08-07)


### Features

* improved progress and job detailing on /jobs/[id] ([7b85a87](https://github.com/territorial-dev/ordo/commit/7b85a877960bf66aba201d2ee1633ed6136df96f))

# [1.6.0](https://github.com/territorial-dev/ordo/compare/v1.5.0...v1.6.0) (2026-08-06)


### Features

* add read-only GET endpoints for job_step_detailing ([89fea5c](https://github.com/territorial-dev/ordo/commit/89fea5c2842e9ef4f2dc03b67e28fde53e6dc562))

# [1.5.0](https://github.com/territorial-dev/ordo/compare/v1.4.0...v1.5.0) (2026-06-01)


### Features

* added max_concurrency ([ed0eb6a](https://github.com/territorial-dev/ordo/commit/ed0eb6a25e4a31509162f2fcd6b3ce3a654a0909))

# [1.4.0](https://github.com/territorial-dev/ordo/compare/v1.3.0...v1.4.0) (2026-03-06)


### Features

* add on_exit lifecycle hook to recipes ([f9e1b81](https://github.com/territorial-dev/ordo/commit/f9e1b81f864071326cf9387b12bcd10c0e7a0cae))

# [1.3.0](https://github.com/territorial-dev/ordo/compare/v1.2.1...v1.3.0) (2026-02-26)


### Features

* added /jobs/:{array_of_ids} endpoint ([426aa84](https://github.com/territorial-dev/ordo/commit/426aa840105e22b1d14246827450682a7ae39688))

## [1.2.1](https://github.com/territorial-dev/ordo/compare/v1.2.0...v1.2.1) (2026-02-25)


### Bug Fixes

* return 400 instead of 500 for job validation errors ([8a8d11c](https://github.com/territorial-dev/ordo/commit/8a8d11ce21744f2a5925ca10df4336f0d90babcf))

# [1.2.0](https://github.com/territorial-dev/ordo/compare/v1.1.0...v1.2.0) (2026-02-25)


### Bug Fixes

* allows ommiting the definiton on a recipe if it exists ([f458b4b](https://github.com/territorial-dev/ordo/commit/f458b4b173b3a827eb77a1476d776eaa41c5725c))
* include n8n_workflow in listStepExecutors query ([79aa349](https://github.com/territorial-dev/ordo/commit/79aa349569a783f5b947709ef56d7d37907b2da9))


### Features

* added description and params metadata to step executors ([7b01b68](https://github.com/territorial-dev/ordo/commit/7b01b68b3ba12fae924e8582f83e1b7ae274d036))

# [1.1.0](https://github.com/territorial-dev/ordo/compare/v1.0.0...v1.1.0) (2026-02-25)


### Features

* added progress to /job/:id endpoint ([70a1aba](https://github.com/territorial-dev/ordo/commit/70a1aba904c462b19f71ed9fa1d1758133950e99))

# 1.0.0 (2026-02-24)


* feat!: remove legacy recipe schema support, enforce v2 as mandatory ([35fd8f1](https://github.com/territorial-dev/ordo/commit/35fd8f192bb00d59c009f2b53761c949ff4815ac))


### Bug Fixes

* align 04_skyforest output slot names with step_executor contracts ([8f128f9](https://github.com/territorial-dev/ordo/commit/8f128f9ed05eb7f4610bd5c2b200c2e7d26d1071))
* correct 04_skyforest reference file schema errors ([8d3e557](https://github.com/territorial-dev/ordo/commit/8d3e5578e155f91966991d10daa916198100af2d))
* duplicated job ids weren't givin out meaningful errors ([90c5caf](https://github.com/territorial-dev/ordo/commit/90c5cafc50fe615ba3a1407bb8f027e1bba557d9))
* fixed missing migrations folder on docker ([c4058f2](https://github.com/territorial-dev/ordo/commit/c4058f26b00d46bbe0b5c99810e20dbc1ded51fd))
* missing outputs shouldn't error ([aabc8e1](https://github.com/territorial-dev/ordo/commit/aabc8e159dba440c81497522701c069c107d1d68))
* removed job: from artifact when storing in db ([f3b163c](https://github.com/territorial-dev/ordo/commit/f3b163cc5f2ec7bc1f4357d7155cd6064811131c))


### Features

* add layered v2 validation in validateRecipe ([ae813c4](https://github.com/territorial-dev/ordo/commit/ae813c4b08c7a8d80bfdf86a538754ace444e1e7))
* add StepDefinitionV2 and RecipeDefinitionV2 types for new recipe schema ([a5098a7](https://github.com/territorial-dev/ordo/commit/a5098a78c3654fbdc6b49ecd9716c83db48db0e4))
* added endpoint for recipe validation + changed how validation works ([8cb2e79](https://github.com/territorial-dev/ordo/commit/8cb2e79c64cab5cb10508d3b42ecb186c86c6c77))
* added endpoints for jobs, artifacts and outputs retrieval ([e0c6454](https://github.com/territorial-dev/ordo/commit/e0c645404638e0a8fbeeaddaa4bb834b382af624))
* added outputs to job endpoint ([7adc7f8](https://github.com/territorial-dev/ordo/commit/7adc7f874db6d0ce4176270cb8861b94ae060cfb))
* added semantic versioning ([87a4f72](https://github.com/territorial-dev/ordo/commit/87a4f72d4c37c92a277c217d29b90d8278a29fe6))
* added stable outputs at the end of the recipe ([cdbfe68](https://github.com/territorial-dev/ordo/commit/cdbfe68899adad2d89a5956c7712510149238cee))
* added validation to prevent two equal named outputs ([c40b838](https://github.com/territorial-dev/ordo/commit/c40b8387579796bfe024e6588c6262dee8677f63))
* create dockerfile and gh action ([06e11df](https://github.com/territorial-dev/ordo/commit/06e11df6372db7876015350122e28d6c6e6458a8))
* created control plane api ([f3ffd8d](https://github.com/territorial-dev/ordo/commit/f3ffd8d12987bdd4a4759cb82993f1c5d74d77a0))
* move step params from recipe to job level ([d560d7f](https://github.com/territorial-dev/ordo/commit/d560d7fd35870def4318da03915b82a38cb4aad6))
* persist job_output ([ab4ce1f](https://github.com/territorial-dev/ordo/commit/ab4ce1ff0d6292ec0333a4ba5ba1e06b81e9470b))


### BREAKING CHANGES

* The legacy recipe format is no longer accepted.

Types:
- Consolidate StepDefinitionV2 → StepDefinition with outputs: Record<string,string>
  and param_keys; remove the old StepDefinition (outputs: string[]) and all V2 aliases
- RecipeDefinitionV2 → RecipeDefinition; old interfaces removed

Validation (validation.ts):
- Remove isNewSchemaStep dispatch, getOutputArtifactNames, legacy validateStep,
  legacy validateOutputsMatchProduces — single path for all recipes now
- Enforce namespaced artifact references (job:<n>, step:<id>.<slot>) in all
  inputs and outputs values; bare names are rejected
- Detect legacy patterns (array outputs, required_params, concrete params) and
  return actionable migration errors explaining exactly what to change
- validateOutputsMatchProduces now checks Record keys against executor.produces

Runtime (jobService.ts):
- step.outputs.forEach → Object.values(step.outputs).forEach
- step.required_params → step.param_keys

Reference files:
- Migrate all 5 reference/*.json files to v2 format (typed outputs, namespaced
  artifact refs, param_keys, job-level inputs/outputs keys updated)
- Fix pre-existing duplicate step ID in 03_simple_flight_point_cloud.json

Docs (README.md):
- Update POST /recipes and POST /recipes/validate examples to v2 format
- Update Recipe Validation section (param_keys, namespaced refs mandatory)
- Replace legacy Example Pipeline with current format (recipe + job request)
- Replace "New Recipe Format" intro section with focused "Recipe Format" section
- Add "Migrating from the Legacy Format" section with 5 before/after examples

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
