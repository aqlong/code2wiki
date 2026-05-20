---
code2wiki_id: cfml-core-mura-publisher-publish-v1
title: Publish a Site to Production
slug: publish-a-site-to-production
actor: Internal deployment service or administrator tool (no HTTP-level access check visible in this region)
status: active
last_generated: '2026-05-07T18:18:06.098Z'
last_commit: b67d9b7
confidence: high
source_files:
  - path: core/mura/publisher.cfc
    lines: 3406-3498
tags:
  - deployment
  - publish
  - production-sync
  - file-copy
  - plugin-events
  - application-reload
  - multi-server
---

## Summary

Copies a site's content, files, assets, and plug-ins from the staging or authoring environment to one or more production destinations. After the copy is complete, both the staging and every production database are updated to record the moment of deployment, and all connected production servers are instructed to reload the application.

## Actor and triggers

- **Actor:** Internal deployment service or administrator tool (no HTTP-level access check visible in this region)

- **Trigger:** A publish or deploy action is initiated for a named site, with a specified push mode (full or changes-only).

## Preconditions

- A valid site identifier must be supplied.
- The site must already exist in the system with at least one configured production database, web root, file directory, or asset directory.
- The staging database and file system must be accessible.
- All production database connections, web roots, file directories, and asset directories must be reachable.

## Main flow

1. The system determines whether this is a full publish or an incremental (changes-only) publish. [^step1]
2. If changes-only mode is selected, the system looks up the date and time of the last successful deployment for the site. If it is a full publish, the last-deployment date is ignored. [^step2]
3. If a valid last-deployment date exists (changes-only mode), the system compiles a list of items that were deleted from the site since that date, so they can be removed from production as well. [^step3]
4. The system notifies all installed plug-ins that a site deployment is about to begin, giving them the opportunity to perform pre-deployment actions. [^step4]
5. For each configured production database, the system synchronises the site's content records from the staging database to the production database, including applying deletions when in changes-only mode. [^step5]
6. If a production asset path is configured, the system copies asset files from the staging asset location to each production asset location. [^step6]
7. For a full publish only (no valid last-deployment date), the system copies the entire site web folder from staging to each configured production web root. [^step7]
8. For every installed plug-in, the system copies the plug-in's files from the staging web root to each production web root. Files changed after the last deployment date are copied even in changes-only mode. [^step8]
9. If a legacy plug-in mappings file exists on any production web root, the system deletes it so that stale path mappings do not persist. [^step9]
10. The system copies site-specific uploaded or managed files from the staging file directory to each configured production file directory, respecting the last-deployment date in changes-only mode. [^step10]
11. If a separate production asset directory is configured and it is not the same location as the production file directory, the system copies asset files there as well. [^step11]
12. The system records the current date and time as the new 'last deployment' timestamp in the staging database for this site. [^step12]
13. The system records the same deployment timestamp in every production database for this site. [^step13]
14. The system sets an application-reload flag in every production database, instructing all production servers to reload the application immediately. [^step14]
15. The system notifies all installed plug-ins that the deployment has finished, passing along any errors that were collected during file-copy operations. [^step15]

[^step1]: lines 3420-3422: pushMode compared to 'changesOnly'
[^step2]: lines 3416-3422
[^step3]: lines 3424-3428
[^step4]: lines 3430-3431: onSiteDeploy and onBeforeSiteDeploy events fired
[^step5]: lines 3433-3435: getToWork called per production datasource
[^step6]: lines 3436-3438
[^step7]: lines 3440-3444
[^step8]: lines 3446-3455
[^step9]: lines 3453-3455
[^step10]: lines 3457-3461
[^step11]: lines 3463-3468
[^step12]: lines 3474-3477: update tsettings on staging datasource
[^step13]: lines 3479-3483: update tsettings on each production datasource
[^step14]: lines 3484-3486: update tglobals set appreload — no site or tenant filter applied
[^step15]: lines 3488-3489: onAfterSiteDeploy event fired

## Alternate and exception flows

- **Full publish (no last-deployment date):** When push mode is not 'changes-only', the last-deployment date is cleared and the entire site web folder is copied to production, regardless of what has changed. No deleted-items list is compiled.
- **Changes-only publish with valid last-deployment date:** Only content records, files, and assets modified or created after the last deployment are synchronised. Items deleted since the last deployment are also propagated to production.
- **File copy errors during deployment:** If any file or directory copy operation fails, the error is collected but does not stop the deployment. All errors are bundled and passed to plug-ins via the after-deploy event, where they can be logged or reported.
- **No production asset path configured:** If no production asset path is set, the asset-file copy step is skipped entirely and the deployment continues with the remaining steps.
- **Production asset directory overlaps production file directory:** If the production asset directory is the same path as the production file directory, the asset-directory copy step is skipped to avoid duplicating work.

## Postconditions

- All configured production databases contain an up-to-date copy of the site's content records.
- All configured production web roots, file directories, and asset directories contain an up-to-date copy of the site's files.
- All configured production databases have their 'last deployment' timestamp updated to the current date and time.
- The staging database also has its 'last deployment' timestamp updated to the current date and time.
- Every production server is flagged to reload the application, affecting all sites hosted on those servers.
- All installed plug-ins have been notified that deployment has completed.

## Business rules

- A 'changes-only' publish uses the last recorded deployment date to limit what is copied; any other push mode triggers a full copy regardless of what has previously been deployed. [^rule1]
- Items deleted from the site since the last deployment are explicitly propagated to production, but only when a valid last-deployment date exists. [^rule2]
- The application-reload flag is written to the production database table without any site or tenant filter, meaning the reload instruction affects ALL sites running on every targeted production server, not only the site being published. This is a broad operational impact. [^rule3]
- The plug-in mappings file is always deleted from production after plug-in files are copied, to prevent stale path configurations from being used. [^rule4]
- Plug-in files are always copied to every production web root during any deployment, even in changes-only mode (using the last-deployment date as a filter rather than skipping the copy entirely). [^rule5]
- File copy errors are non-fatal; they are accumulated and reported to plug-ins after the deployment completes rather than halting the process. [^rule6]
- Both the staging and all production databases are updated with the deployment timestamp, keeping the recorded deployment state consistent across environments. [^rule7]
- Three plug-in event hooks are fired in sequence — one at the start, one immediately before copying begins, and one after everything completes — allowing plug-ins to customise or react to the deployment at multiple stages. [^rule8]

[^rule1]: lines 3420-3422
[^rule2]: lines 3424-3428
[^rule3]: lines 3484-3486: UPDATE tglobals set appreload with no WHERE clause
[^rule4]: lines 3453-3455
[^rule5]: lines 3446-3451
[^rule6]: lines 3448-3450, 3488
[^rule7]: lines 3474-3483
[^rule8]: lines 3430-3431, 3488-3489

## Suggested test scenarios

- **Happy path — full publish** — Given a site with content, files, assets, and plug-ins configured, and push mode set to 'full', when the publish action is triggered, then all content records, files, assets, and plug-in files are copied to every production destination, both staging and production timestamps are updated, and all production servers are flagged to reload.
- **Happy path — changes-only publish** — Given a site with a recorded last-deployment date and push mode set to 'changesOnly', when the publish action is triggered, then only records and files changed or deleted since the last deployment are synchronised, and the deployment timestamp is updated in all databases.
- **Application reload affects all sites** — Given multiple sites hosted on the same production server, when any one site is published, then the application-reload flag is set for the entire production server, causing all sites on that server to reload — not just the published site.
- **File copy error does not abort deployment** — Given a production file directory that is temporarily read-only for one item, when the publish action is triggered, then the error is recorded but the deployment continues, and the error details are passed to plug-ins via the after-deploy event.
- **Changes-only publish with no prior deployment** — Given a site with no recorded last-deployment date and push mode set to 'changesOnly', when the publish action is triggered, then the system falls back to a full publish because no valid last-deployment date can be found.
- **Production asset directory same as file directory** — Given a site where the configured production asset directory path matches the production file directory path, when the publish action is triggered, then the asset-directory copy step is skipped and files are not copied twice.
- **Stale plug-in mappings file removed** — Given a production web root that contains a legacy plug-in mappings file, when the publish action completes the plug-in file copy, then the mappings file is deleted from the production web root.

## Related use cases

- [Deploy Site in Changes-Only Mode](deploy-site-changes-only)
- [Manage Site Plug-ins](manage-site-plugins)
- [Application Reload on Production Server](application-reload-on-production)
- [Track Site Deployment History](track-site-deployment-history)

## Source links

<details>

<summary>Implementation files (for developers and auditors)</summary>



- `core/mura/publisher.cfc` lines 3406-3498



</details>

---

<!-- code2wiki:managed:start id=cfml-core-mura-publisher-publish-v1 -->
*Generated by [code2wiki](https://github.com/aqlong/code2wiki) from commit `b67d9b7` on 2026-05-07T18:18:06.098Z.*
*Confidence: **high** — The function is well-structured with clear conditional logic, explicit database writes, and named plug-in events. The business intent of each block is unambiguous from the code. The only area of uncertainty is whether external callers enforce access control before invoking this function, which is outside the focus region.*
<!-- code2wiki:managed:end -->
