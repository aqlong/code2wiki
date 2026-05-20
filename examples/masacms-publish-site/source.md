# Source pointer: MasaCMS — Publish a Site to Production

**Upstream repository:** [MasaCMS/MasaCMS](https://github.com/MasaCMS/MasaCMS)
**License:** GPL v2 (with linking exception)
**File:** `core/mura/publisher.cfc`
**Use case region:** Lines 3406–3498 (`<cffunction name="publish">`)
**Local clone path:** `references/masa-cms/core/mura/publisher.cfc`

## Why this use case

A real legacy CFML function that:
- Uses tag-based syntax (`<cffunction>`, `<cfargument>`, `<cfquery>`, `<cfloop>`)
- Coordinates a multi-step deployment workflow with side effects (DB, files, plugins, events)
- Has implicit business rules ("changesOnly" mode behavior) that a non-developer needs to understand
- Lives in a 3,700-line file alongside dozens of other functions — a realistic challenge for the extractor to isolate

This is exactly the kind of tag-based CFML that exists nowhere else in the AI-tools ecosystem.

## Specific code under analysis

```cfml
<cffunction name="publish">
    <cfargument name="siteid" required="yes" default="">
    <cfargument name="pushMode" required="yes" default="">

    <cfset var fileDelim=application.configBean.getFileDelim() />
    <cfset var rsPlugins=application.pluginManager.getSitePlugins(arguments.siteid)>
    <cfset var pluginEvent = createObject("component","mura.event").init(arguments) />
    <cfset var lastDeployment=application.settingsManager.getSite(arguments.siteID).getLastDeployment()>
    <cfset var rsDeleted=queryNew("objectID")>

    <cfif arguments.pushMode neq "changesOnly">
        <cfset lastDeployment="">
    </cfif>

    <!-- ... copies DB content, files, plugins, asset directories,
         to one or more production datasources / webroots ... -->

    <cfquery datasource="#application.configBean.getDatasource()#" ...>
        update tsettings set lastDeployment = #createODBCDateTime(now())#
        where siteID=...
    </cfquery>

    <cfset application.pluginManager.announceEvent("onAfterSiteDeploy",pluginEvent)>
</cffunction>
```
