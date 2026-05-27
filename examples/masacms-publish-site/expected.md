---
code2wiki_id: cfml-masacms-publish-site-v1
title: Publish a Site to Production
slug: publish-a-site-to-production
actor: CMS administrator with deploy permission, or a scheduled deployment job
status: active
last_generated: 2026-05-07T00:00:00Z
last_commit: 0000000
confidence: high
source_files:
  - path: core/mura/publisher.cfc
    lines: 3406-3498
tags:
  - deployment
  - publishing
  - admin
  - production
---

## Summary

An administrator pushes the current state of a site (content, files, plugins, assets) from the staging environment to one or more configured production environments. They can choose between a full push (everything) or a changes-only push (only items modified since the last deployment).

## Actor and triggers

- **Actor:** A CMS administrator with deployment permission, or a scheduled job calling the publisher API.
- **Trigger:** The administrator clicks a "Publish" or "Deploy" button in the admin UI for a specific site, or a scheduled task invokes `publisher.publish(siteid, pushMode)`.

## Preconditions

- The site exists in the staging environment.
- At least one production datasource and webroot are configured in the application config.
- The deploying user (or scheduler) has access to the publisher component.

## Main flow

1. The administrator selects a site and a push mode (either "Full" or "Changes Only") and starts the deployment.
2. The system gathers the deployment context: the file separator for the OS, the list of plugins installed on the site, and an event object that plugins can hook into.
3. The system looks up the timestamp of the last successful deployment for this site. If the administrator chose "Changes Only", that timestamp is kept; if they chose "Full", it is cleared so that everything is re-deployed.
4. If the deployment is incremental (Changes Only), the system also gathers a list of items that have been deleted since the last deployment, so they can be removed from production.
5. The system fires the `onSiteDeploy` and `onBeforeSiteDeploy` events, giving plugins a chance to react before any data moves.
6. For each configured production database, the system copies the site's database content from staging into production. If a separate "asset path" datasource is configured, it copies the site's assets there as well.
7. **Only on a Full deployment:** The system copies the site's webroot files into each configured production webroot.
8. For each production webroot, the system copies any plugin files for plugins installed on the site, then deletes the plugins mappings file so it will be regenerated on the production instance.
9. The system copies the site's file directory and asset directory into the configured production locations.
10. The system records the deployment by updating the `lastDeployment` timestamp on the staging settings table and on each production settings table.
11. The system flags every production database to reload the application by updating the `appreload` timestamp on the global settings table. This forces production CFML servers to re-read configuration on the next request.
12. The system fires the `onAfterSiteDeploy` event with any errors that were collected during file copying, so plugins can log, alert, or recover.

## Alternate and exception flows

- **Plugin handler raises an event listener exception:** Errors raised by plugin event listeners during `onSiteDeploy` / `onBeforeSiteDeploy` / `onAfterSiteDeploy` are not caught here; they propagate up. A misbehaving plugin can therefore halt a deployment partway.
- **File copy errors:** Errors encountered while copying files (webroot, plugins, file directory, asset directory) are collected into an `errors` array and passed to the `onAfterSiteDeploy` event rather than aborting the deployment. The deployment is considered "completed with errors" rather than "failed."
- **Production datasource unreachable:** If a production database is offline, the `update tsettings` and `update tglobals` queries will throw an exception that aborts the deployment after files have already been copied. The system can be left in a partially deployed state.
- **First-ever deployment for a site (no prior `lastDeployment`):** The "deleted items" list defaults to empty, and `Changes Only` mode behaves identically to `Full` because the absence of a last-deployment date triggers a full webroot copy.

## Postconditions

- Production database content for the site matches staging (within the chosen push mode).
- Production webroot, plugin, file, and asset directories contain the latest files from staging.
- Both staging and production settings tables show the current timestamp as `lastDeployment`.
- Every production database has its `appreload` flag updated, so CFML application scope on production servers will reload on the next request.
- The `onAfterSiteDeploy` event has been fired with any collected file-copy errors.

## Business rules

- **Push mode controls scope.** Any value other than the literal string `"changesOnly"` is treated as a Full deployment. A typo in the push-mode argument silently degrades to Full.[^pushmode]
- **Webroot files are only copied on Full deployments.** Changes-only mode skips the webroot file copy entirely; only the database, plugins, and file/asset directories are updated incrementally.[^webroot]
- **Plugins mappings file is regenerated on every deploy.** The system unconditionally deletes the `plugins/mappings.cfm` file in each production webroot; the production instance will rebuild it on its next request.[^mappings]
- **Multiple production datasources are supported.** The configured `productionDatasource` is a comma-separated list; the publisher iterates over every entry.[^multi]
- **App reload is global, not per-site.** Updating `tglobals.appreload` causes all sites on the production server to reload, not just the one being deployed.[^appreload]

[^pushmode]: Implemented at line 3425, `<cfif arguments.pushMode neq "changesOnly">` — any non-matching string clears the lastDeployment timestamp.
[^webroot]: Implemented at line 3445, `<cfif not isDate(lastDeployment)>` — the webroot copy loop runs only when `lastDeployment` is empty (i.e., Full mode or first-ever deploy).
[^mappings]: Implemented at lines 3458–3460, unconditional `<cffile action="delete">` for `plugins/mappings.cfm`.
[^multi]: Implemented across the function via `<cfloop list="#application.configBean.getProductionDatasource()#">` at lines 3438, 3486.
[^appreload]: Implemented at line 3492, `update tglobals set appreload = ...` — affects all sites.

## Suggested test scenarios

- **Happy path, full deployment** — Given a site with prior content, when the administrator publishes with mode `"full"`, then the production database is updated, all webroot files are copied, file/asset directories are synced, and `lastDeployment` is updated on both staging and production.
- **Changes-only deployment** — Given a site that was deployed yesterday and a new content row created today, when the administrator publishes with mode `"changesOnly"`, then only the new content is pushed and the webroot files are not re-copied.
- **First-ever deployment with `changesOnly`** — Given a site that has never been deployed, when the administrator publishes with mode `"changesOnly"`, then the system behaves as a Full deployment because there is no prior `lastDeployment` timestamp.
- **Push-mode typo** — Given a call with `pushMode="changes_only"` (underscore instead of camelCase), when the deployment runs, then it silently performs a Full deployment.
- **Multiple production datasources configured** — Given two production datasources, when a Full deployment runs, then both databases receive content updates and both have their `lastDeployment` timestamp updated.
- **Plugin event handler throws** — Given a plugin that throws on `onBeforeSiteDeploy`, when the administrator publishes, then the deployment aborts before any files are copied and the error propagates to the caller.
- **File copy error mid-deployment** — Given the production webroot is read-only for one file, when a Full deployment runs, then the rest of the deployment continues, the error is captured in the `errors` array, and the `onAfterSiteDeploy` event receives it.
- **Production database offline** — Given the production database is unreachable, when the deployment reaches the `update tsettings` query, then the function throws and the system is left in a state where files have been copied but the deployment timestamp is not recorded.
- **Site has no plugins** — Given a site with zero plugins installed, when the administrator publishes, then the plugin-copy and plugin-mappings-deletion loops both run zero iterations and the deployment completes normally.
- **Audit verification** — Given a successful deployment, when the audit log is reviewed, then `onSiteDeploy`, `onBeforeSiteDeploy`, and `onAfterSiteDeploy` events should all be present in plugin event logs.

## Related use cases

- [Stage New Content for Publication](stage-new-content-for-publication) — the upstream flow that creates the changes a deployment will push
- [Roll Back a Deployment](roll-back-a-deployment) — recovery when a deploy goes wrong
- [Configure Production Environments](configure-production-environments) — sets up the datasources and webroots this use case reads from

## Source links

<details>
<summary>Implementation files (for developers and auditors)</summary>

- [`core/mura/publisher.cfc` lines 3406–3498](../../references/masa-cms/core/mura/publisher.cfc) — the `publish` function
- `core/mura/event.cfc` — the event object passed to plugins
- `core/mura/publisherKeys.cfc` — defines which keys are publishable
- `core/mura/pluginManager.cfc` — `announceEvent` and `getSitePlugins`
- `core/mura/configBean.cfc` — production datasource / webroot / file directory config
- Database tables: `tsettings` (per-site `lastDeployment`), `tglobals` (`appreload`), `ttrash` (deleted items query source)

</details>

---

<!-- code2wiki:managed:start id=cfml-masacms-publish-site-v1 -->
*Generated by [code2wiki](https://github.com/craftandship/code2wiki) from commit `0000000` on 2026-05-07.*
*Confidence: **high** — single-function workflow with explicit argument names and clear database/file boundaries. Cross-referenced events and config values cited from sibling files in the same component tree.*
<!-- code2wiki:managed:end -->
