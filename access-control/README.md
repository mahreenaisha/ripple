# Access control catalog

This folder is a self-contained, dependency-free module. Keeping its YAML, parser,
queries, and tests together limits merge conflicts with the scanner and frontend.

## Data

- `users.yaml` owns user profiles, global access levels, and service assignments.
- `services.yaml` adds access metadata to the services discovered in the root
  `services.json`.
- IDs are stable join keys. A user assignment must reference an existing service ID.
- `admin`, `standard`, and `read-only` describe the user's access level; they do not
  implicitly assign extra services.
- The checked-in Alice and Bob records are examples and should be replaced with real
  directory data.

`getUserAccess()` returns external integrations in its `services` property. Internal
service IDs are returned by `getUserServices()`.

## Usage

```js
const access = require("./access-control");

access.getUserServices("alice");
access.getServiceRepos("backend");
access.getUserAccess("alice");
access.canAccess("alice", "backend");
access.getUsersForService("ripple-frontend");
```

Unknown IDs throw from detail queries. `canAccess()` is intentionally safe for
authorization checks and returns `false` for an unknown user or service.

## Validation

Loading the module validates both YAML files, including enum values, duplicate IDs,
required fields, and assignment references.

Run the automated checks from the repository root:

```sh
node --test access-control/index.test.js
```
