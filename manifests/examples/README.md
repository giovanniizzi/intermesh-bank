# Configuration examples

This directory is reserved for sanitized, tracked configuration templates. No
Secret or deployment templates are provided yet.

- Name examples `*.example` or `*.example.*`, such as `.env.example` or
  `postgres-secret.example.yaml`. Keep them outside ignored directories.
- Use obvious replacement markers, fictional identities and reserved domains
  such as `db.example.invalid`. Never include working credentials or previously
  exposed password values. Base64 encoding does not protect a Kubernetes Secret.
- Keep completed copies in the ignored repository-root `.local/` directory, for
  example `.local/postgres-secret.yaml` or `.local/demo.env`. Keep private keys,
  kubeconfigs and cloud or registry credentials there as well.
- Review example contents before staging. Filename exceptions allow examples to
  be tracked; they do not verify that the contents are sanitized.

The ignore rules are safeguards against accidental additions. They do not affect
already tracked files, encrypt local files or configure an application or cluster.
Current-source cleanup and Git history remediation remain separate tasks.
