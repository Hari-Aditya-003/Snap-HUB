# Contributing

Snap HUB welcomes documentation improvements, reproducible bug reports, focused fixes, and tested improvements. Follow the [code of conduct](CODE_OF_CONDUCT.md) when participating.

## Before starting

Read the [README](README.md) and check the [open issues](https://github.com/Hari-Aditya-003/Snap-HUB/issues) and pull requests. If you are new to the project, look for [good first issues](https://github.com/Hari-Aditya-003/Snap-HUB/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and comment on the one you would like to take. Discuss substantial changes in an existing issue or [GitHub Discussions](https://github.com/Hari-Aditya-003/Snap-HUB/discussions). A focused pull request is enough for a small documentation fix.

## Fork and branch

Fork this repository using GitHub, then clone your fork. Replace `YOUR-USERNAME` in the commands below:

```bash
git clone https://github.com/YOUR-USERNAME/Snap-HUB.git
cd Snap-HUB
git remote add upstream https://github.com/Hari-Aditya-003/Snap-HUB.git
git fetch upstream
git switch -c docs/describe-your-change upstream/main
```

Use a descriptive branch name such as `docs/setup-guide` or `fix/gallery-upload`. Target pull requests at `main`.

## Setup and checks

Follow the [local setup](README.md#local-web-development) to run the web app. From the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

`npm run typecheck` runs `tsc --noEmit` across the TypeScript sources (`.ts`, `.tsx`, `.mts`); pull requests run it with lint before the test suite. `npm test` builds the Worker and runs its integration suite with a temporary local D1 database. Describe manual checks for affected host and guest flows. For iOS changes, include the Xcode version, device or simulator, and iOS version you checked. Schema changes must include generated, reviewed Drizzle migrations.

Use synthetic event media and your own OAuth test project for Drive checks. Follow the [deployment guide](docs/DEPLOYMENT.md) to set up a separate Worker and D1 database for a fork.

## Submit a pull request

Keep the diff focused. Explain the problem, resulting behavior, and exact verification performed. Link a related issue when one exists. Documentation changes should use working relative links and commands that start from an explicit directory.

```bash
git add <changed-files>
git commit -m "docs: clarify setup instructions"
git push -u origin docs/describe-your-change
```

Open a pull request from your branch to this repository's `main`. Complete the PR template and respond to review feedback. Do not include unrelated generated files, personal editor state, credentials, or private user data.

## Report a bug or request a feature

Use the [issue templates](https://github.com/Hari-Aditya-003/Snap-HUB/issues/new/choose). For a bug, include the source commit, environment, steps to reproduce, expected result, observed result, and relevant sanitized logs. For a feature, describe the user problem and a verifiable outcome. Send vulnerabilities through the [private reporting channel](SECURITY.md).

## Licensing

Contributions to project-owned software and documentation are accepted under the [MIT License](LICENSE). Credit third-party material you include and retain its license and attribution. See the [notices](NOTICE.md) for existing exceptions.
