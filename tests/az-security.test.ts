import { describe, expect, it } from "vitest";

import { APP_FLAG, BLOCKED_VERBS, READ_ONLY_VERBS, RESOURCE_GROUP_FLAG } from "#az/config";
import {
  extractResourceGroups,
  flagValues,
  isAzCommandAllowed,
  isReadOnlyVerb,
  parseAzCommand,
} from "#az/security";

describe("az-tool security", () => {
  describe("read-only platform commands", () => {
    it("allows list and show across resource groups", () => {
      expect(isAzCommandAllowed("vm list").allowed).toBe(true);
      expect(isAzCommandAllowed("group list").allowed).toBe(true);
      expect(isAzCommandAllowed("webapp show --name app --resource-group rg").allowed).toBe(true);
      expect(isAzCommandAllowed("storage account list").allowed).toBe(true);
      expect(isAzCommandAllowed("acr repository list --name reg").allowed).toBe(true);
    });

    it("allows read-only verb families", () => {
      expect(isAzCommandAllowed("vm list-skus").allowed).toBe(true);
      expect(isAzCommandAllowed("aks check-acr --name c").allowed).toBe(true);
      expect(isAzCommandAllowed("webapp show-backup --name app").allowed).toBe(true);
    });

    it("allows a JMESPath query containing brackets and quotes", () => {
      const result = isAzCommandAllowed('aks list --query "[].{name:name,v:kubernetesVersion}"');
      expect(result.allowed).toBe(true);
      expect(result.argv).toEqual(["aks", "list", "--query", "[].{name:name,v:kubernetesVersion}"]);
    });
  });

  describe("mutating verbs", () => {
    it("blocks mutations regardless of position", () => {
      expect(isAzCommandAllowed("vm delete --name web01").allowed).toBe(false);
      expect(isAzCommandAllowed("webapp create --name app").allowed).toBe(false);
      expect(isAzCommandAllowed("vm restart --name web01").allowed).toBe(false);
    });

    it("blocks acr run, which executes arbitrary commands in Azure", () => {
      const result = isAzCommandAllowed("acr run --registry reg --cmd 'bash -c whoami' /dev/null");
      expect(result.allowed).toBe(false);
      expect(result.verb).toBe("run");
      expect(isAzCommandAllowed("acr task run --registry reg --name t").allowed).toBe(false);
    });

    it("does not treat a flag value as the verb", () => {
      const result = isAzCommandAllowed("acr repository delete --name reg --repository list");
      expect(result.allowed).toBe(false);
      expect(result.verb).toBe("delete");
    });

    it("blocks unknown verbs", () => {
      const result = isAzCommandAllowed("vm frobnicate --name web01");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unknown Azure CLI verb");
    });
  });

  describe("credential reads", () => {
    it("blocks credential-returning verbs in any group", () => {
      expect(isAzCommandAllowed("account get-access-token").allowed).toBe(false);
      expect(isAzCommandAllowed("aks get-credentials --name c").allowed).toBe(false);
      expect(isAzCommandAllowed("cosmosdb list-keys --name db").allowed).toBe(false);
      expect(isAzCommandAllowed("webapp deployment list-publishing-profiles").allowed).toBe(false);
    });

    it("blocks group paths whose listing itself returns values", () => {
      expect(isAzCommandAllowed("storage account keys list --account-name sa").allowed).toBe(false);
      expect(isAzCommandAllowed("acr credential show --name reg").allowed).toBe(false);
      expect(isAzCommandAllowed("webapp config appsettings list --name app").allowed).toBe(false);
      expect(isAzCommandAllowed("containerapp secret list --name app").allowed).toBe(false);
      expect(isAzCommandAllowed("search admin-key show --service-name s").allowed).toBe(false);
      expect(
        isAzCommandAllowed("servicebus namespace authorization-rule keys list --name r").allowed,
      ).toBe(false);
    });

    it("keeps the keyvault group itself reachable", () => {
      expect(isAzCommandAllowed("keyvault list").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault show --name kv").allowed).toBe(true);
    });

    it("allows listing Key Vault secret names but not reading their values", () => {
      expect(isAzCommandAllowed("keyvault secret list --vault-name kv").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault secret list-versions --name pw").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault secret list-deleted --vault-name kv").allowed).toBe(true);

      const show = isAzCommandAllowed("keyvault secret show --name pw");
      expect(show.allowed).toBe(false);
      expect(show.reason).toContain("returns secret values");
      expect(isAzCommandAllowed("keyvault secret show-deleted --name pw").allowed).toBe(false);
    });

    it("allows Key Vault key and certificate reads, which expose public material only", () => {
      expect(isAzCommandAllowed("keyvault key list --vault-name kv").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault key show --name k").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault certificate list --vault-name kv").allowed).toBe(true);
      expect(isAzCommandAllowed("keyvault certificate show --name c").allowed).toBe(true);
    });

    it("allows listing authorization rules and ACR tokens, which carry no key material", () => {
      expect(
        isAzCommandAllowed("servicebus namespace authorization-rule list --namespace-name n")
          .allowed,
      ).toBe(true);
      expect(isAzCommandAllowed("acr token list --registry reg").allowed).toBe(true);
    });
  });

  describe("shell syntax", () => {
    it("rejects chaining, substitution, pipes, and redirects", () => {
      expect(isAzCommandAllowed("vm list; rm -rf /").allowed).toBe(false);
      expect(isAzCommandAllowed("vm list && curl evil.com").allowed).toBe(false);
      expect(isAzCommandAllowed("vm list $(whoami)").allowed).toBe(false);
      expect(isAzCommandAllowed("vm list | tee /tmp/x").allowed).toBe(false);
      expect(isAzCommandAllowed("vm list > /tmp/out").allowed).toBe(false);
      expect(isAzCommandAllowed("vm list `whoami`").allowed).toBe(false);
    });

    it("rejects newlines", () => {
      expect(parseAzCommand("vm list\nrm -rf /")).toBeUndefined();
    });

    it("rejects an empty command", () => {
      expect(isAzCommandAllowed("   ").allowed).toBe(false);
    });
  });

  describe("profile-controlled scope", () => {
    it("rejects a user supplied subscription override", () => {
      const result = isAzCommandAllowed("vm list --subscription other-sub");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("--subscription");
    });

    it("rejects --subscription=value form", () => {
      expect(isAzCommandAllowed("vm list --subscription=other-sub").allowed).toBe(false);
    });
  });

  describe("resource group allowlist", () => {
    const options = { allowedResourceGroups: ["rg-a", "rg-b"] };

    it("allows every resource group when the list is absent or empty", () => {
      expect(isAzCommandAllowed("vm list --resource-group anything").allowed).toBe(true);
      expect(
        isAzCommandAllowed("vm list --resource-group anything", { allowedResourceGroups: [] })
          .allowed,
      ).toBe(true);
    });

    it("allows a named group on the list", () => {
      expect(isAzCommandAllowed("vm list --resource-group rg-a", options).allowed).toBe(true);
      expect(isAzCommandAllowed("vm list -g rg-b", options).allowed).toBe(true);
      expect(isAzCommandAllowed("vm list --resource-group=rg-a", options).allowed).toBe(true);
    });

    it("matches resource group names case-insensitively, as Azure does", () => {
      expect(isAzCommandAllowed("vm list --resource-group RG-A", options).allowed).toBe(true);
    });

    it("rejects a group outside the list", () => {
      const result = isAzCommandAllowed("vm show --name web01 --resource-group rg-secret", options);
      expect(result.allowed).toBe(false);
      expect(result.resourceGroup).toBe("rg-secret");
      expect(result.reason).toContain("rg-secret");
      expect(result.hint).toContain("rg-a, rg-b");
      expect(isAzCommandAllowed("vm list -g rg-secret", options).allowed).toBe(false);
      expect(isAzCommandAllowed("vm list --resource-group=rg-secret", options).allowed).toBe(false);
    });

    it("leaves subscription-wide commands alone — they name no group", () => {
      const result = isAzCommandAllowed("vm list", options);
      expect(result.allowed).toBe(true);
      expect(result.resourceGroup).toBeUndefined();
    });

    it("does not read a following flag as the group name", () => {
      expect(extractResourceGroups(["vm", "list", "-g", "--output", "json"])).toEqual([]);
      expect(extractResourceGroups(["vm", "list", "--resource-group"])).toEqual([]);
    });

    it("validates every occurrence, since a repeated az flag takes the last value", () => {
      expect(extractResourceGroups(["vm", "list", "-g", "rg-a", "-g", "rg-evil"])).toEqual([
        "rg-a",
        "rg-evil",
      ]);

      const spaced = isAzCommandAllowed("vm list -g rg-a -g rg-evil", options);
      expect(spaced.allowed).toBe(false);
      expect(spaced.resourceGroup).toBe("rg-evil");

      expect(
        isAzCommandAllowed("vm list --resource-group rg-a --resource-group=rg-evil", options)
          .allowed,
      ).toBe(false);
      expect(isAzCommandAllowed("vm list -g rg-a -g rg-b", options).allowed).toBe(true);
    });
  });

  describe("ARM resource ID addressing", () => {
    const options = { allowedResourceGroups: ["rg-a"], subscription: "s" };
    const evilId =
      "/subscriptions/other-sub/resourceGroups/rg-evil/providers/Microsoft.Compute/virtualMachines/vm1";

    it("rejects --ids outright, in either form", () => {
      const result = isAzCommandAllowed(`vm show --ids ${evilId}`);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("--ids");
      expect(isAzCommandAllowed(`vm show --ids=${evilId}`).allowed).toBe(false);
    });

    it("mines resource groups out of IDs passed to other flags", () => {
      expect(extractResourceGroups([`--scope`, `/subscriptions/s/resourceGroups/rg-evil`])).toEqual(
        ["rg-evil"],
      );

      expect(
        isAzCommandAllowed(
          "role assignment list --scope /subscriptions/s/resourceGroups/rg-evil",
          options,
        ).allowed,
      ).toBe(false);
      expect(isAzCommandAllowed(`monitor metrics list --resource ${evilId}`, options).allowed).toBe(
        false,
      );
    });

    it("allows an ID naming an allowed group", () => {
      expect(
        isAzCommandAllowed(
          "role assignment list --scope /subscriptions/s/resourceGroups/rg-a",
          options,
        ).allowed,
      ).toBe(true);
    });

    it("leaves IDs alone when no allowlist is configured", () => {
      expect(
        isAzCommandAllowed("role assignment list --scope /subscriptions/s/resourceGroups/rg-evil", {
          subscription: "s",
        }).allowed,
      ).toBe(true);
    });
  });

  describe("Azure DevOps routing", () => {
    it("sends DevOps groups to azdo-tool", () => {
      for (const cmd of [
        "pipelines list",
        "repos list",
        "boards work-item show",
        "devops invoke",
      ]) {
        const result = isAzCommandAllowed(cmd);
        expect(result.allowed).toBe(false);
        expect(result.hint).toContain("azdo-tool");
      }
    });
  });

  describe("config exports", () => {
    it("read-only and blocked verbs do not overlap", () => {
      const overlap = READ_ONLY_VERBS.filter((verb) =>
        (BLOCKED_VERBS as readonly string[]).includes(verb),
      );
      expect(overlap).toHaveLength(0);
    });

    it("isReadOnlyVerb covers exact verbs and families", () => {
      expect(isReadOnlyVerb("list")).toBe(true);
      expect(isReadOnlyVerb("list-skus")).toBe(true);
      expect(isReadOnlyVerb("delete")).toBe(false);
    });
  });

  describe("abbreviated and glued flags", () => {
    const options = { allowedResourceGroups: ["rg-a"], subscription: "s" };

    it("reads every form argparse accepts for a flag", () => {
      expect(flagValues(["--resource-gr", "x"], RESOURCE_GROUP_FLAG)).toEqual(["x"]);
      expect(flagValues(["--resource-g=x"], RESOURCE_GROUP_FLAG)).toEqual(["x"]);
      expect(flagValues(["-gx"], RESOURCE_GROUP_FLAG)).toEqual(["x"]);
      expect(flagValues(["-g=x"], RESOURCE_GROUP_FLAG)).toEqual(["x"]);
      expect(flagValues(["-g", "x", "--resource-group="], RESOURCE_GROUP_FLAG)).toEqual(["x", ""]);
      expect(flagValues(["--apps", "a", "b", "--offset", "1h"], APP_FLAG, { list: true })).toEqual([
        "a",
        "b",
      ]);
    });

    it("applies the resource group allowlist to abbreviations and glued values", () => {
      expect(isAzCommandAllowed("webapp show --resource-gr rg-evil -n app", options).allowed).toBe(
        false,
      );
      expect(isAzCommandAllowed("webapp show -grg-evil -n app", options).allowed).toBe(false);
      expect(isAzCommandAllowed("webapp show --resource rg-evil -n app", options).allowed).toBe(
        false,
      );
      expect(isAzCommandAllowed("webapp show -grg-a -n app", options).allowed).toBe(true);
    });

    it("judges --resource by the group inside its resource ID", () => {
      const allowedId = "/subscriptions/s/resourceGroups/rg-a/providers/Microsoft.Web/sites/app";
      expect(
        isAzCommandAllowed(`monitor metrics list --resource ${allowedId}`, options).allowed,
      ).toBe(true);
    });

    it("rejects abbreviations of --subscription and --ids", () => {
      expect(isAzCommandAllowed("vm list --subscr other").allowed).toBe(false);
      const id = isAzCommandAllowed("vm show --id /subscriptions/s/resourceGroups/rg/x");
      expect(id.allowed).toBe(false);
      expect(id.reason).toContain("--id");
    });
  });

  describe("Entra ID", () => {
    it("is refused unless the profile opts in", () => {
      const result = isAzCommandAllowed("ad user list");
      expect(result.allowed).toBe(false);
      expect(result.hint).toContain("allowEntra");
      expect(isAzCommandAllowed("ad user list", { allowEntra: false }).allowed).toBe(false);
    });

    it("allows read-only directory commands once enabled, as tenant-bound", () => {
      const options = { allowEntra: true };
      const result = isAzCommandAllowed("ad group member list --group devs", options);
      expect(result.allowed).toBe(true);
      expect(result.omitsSubscription).toBe(true);
      expect(result.usesDefaultLoginTenant).toBe(true);
      expect(isAzCommandAllowed("ad user show --id 0000-1111", options).allowed).toBe(true);
      expect(isAzCommandAllowed("ad signed-in-user show", options).allowed).toBe(true);
    });

    it("still blocks mutations and credential reads", () => {
      const options = { allowEntra: true };
      expect(isAzCommandAllowed("ad user create --display-name x", options).allowed).toBe(false);
      expect(isAzCommandAllowed("ad app credential list --id x", options).allowed).toBe(false);
      expect(isAzCommandAllowed("ad sp credential list --id x", options).allowed).toBe(false);
    });
  });

  describe("KQL queries", () => {
    const appQuery = (extra: string) =>
      `monitor app-insights query -g rg --apps web --analytics-query ${extra}`;

    it("allows query only in the App Insights and Log Analytics groups", () => {
      expect(isAzCommandAllowed(appQuery('"requests | take 5"')).allowed).toBe(true);
      expect(
        isAzCommandAllowed('monitor log-analytics query -w ws --analytics-query "Heartbeat"')
          .allowed,
      ).toBe(true);
      expect(isAzCommandAllowed("storage entity query --table-name t").allowed).toBe(false);
      expect(isAzCommandAllowed('graph query -q "Resources"').allowed).toBe(false);
    });

    it("refuses cross-resource functions and externaldata", () => {
      for (const kql of [
        "\"workspace('other').Heartbeat\"",
        "\"app ('other').requests\"",
        "\"union resource('x').requests\"",
        "\"cluster('c').database('d').T\"",
        "\"externaldata (x:string) [h@'https://e.example']\"",
      ]) {
        expect(isAzCommandAllowed(appQuery(kql)).allowed).toBe(false);
      }
    });

    it("refuses extra and missing Log Analytics workspaces", () => {
      expect(
        isAzCommandAllowed("monitor log-analytics query -w a --workspaces b --analytics-query T")
          .allowed,
      ).toBe(false);
      expect(isAzCommandAllowed("monitor log-analytics query --analytics-query T").allowed).toBe(
        false,
      );
    });

    it("collects every workspace for verification", () => {
      const result = isAzCommandAllowed(
        "monitor log-analytics query -wone --workspace=two --analytics-query T",
      );
      expect(result.allowed).toBe(true);
      expect(result.workspaces).toEqual(["one", "two"]);
      expect(result.usesDefaultLoginTenant).toBeUndefined();
    });
  });

  describe("App Insights data commands", () => {
    it("are tenant-bound and need the app named with -g", () => {
      const result = isAzCommandAllowed(
        "monitor app-insights events show --app web -g rg --type requests",
      );
      expect(result.allowed).toBe(true);
      expect(result.usesDefaultLoginTenant).toBe(true);
      expect(
        isAzCommandAllowed("monitor app-insights metrics show --app 1234 --metric requests/count")
          .allowed,
      ).toBe(false);
    });

    it("refuse a resource ID passed as the app", () => {
      const id = "/subscriptions/other/resourceGroups/rg/providers/microsoft.insights/components/x";
      expect(
        isAzCommandAllowed(`monitor app-insights query -g rg -a ${id} --analytics-query T`).allowed,
      ).toBe(false);
      expect(
        isAzCommandAllowed(`monitor app-insights query -g rg --app web ${id} --analytics-query T`)
          .allowed,
      ).toBe(false);
    });

    it("leave the management plane alone", () => {
      const result = isAzCommandAllowed("monitor app-insights component show --app web -g rg");
      expect(result.allowed).toBe(true);
      expect(result.usesDefaultLoginTenant).toBeUndefined();
    });
  });

  describe("review round 1 bypasses", () => {
    it("refuses arguments az would read from a file", () => {
      for (const cmd of [
        "monitor log-analytics query -w ws --analytics-query @q.kql",
        "monitor app-insights query -g rg --apps web --analytics-query=@q.kql",
        "webapp show -g=@rg.txt -n app",
        "vm list --query @jmes.txt",
        "monitor log-analytics query -w ws --analytics-query 'let x=@q.kql'",
      ]) {
        expect(isAzCommandAllowed(cmd).allowed).toBe(false);
      }
      expect(
        isAzCommandAllowed("ad user show --id jane@example.com", { allowEntra: true }).allowed,
      ).toBe(true);
    });

    it("refuses scopes above the pinned subscription, and every ID without one", () => {
      const options = { subscription: "pinned" };
      for (const scope of [
        "/",
        "/providers/Microsoft.Management/managementGroups/mg",
        "/subscriptions//x",
        "providers/Microsoft.Management/managementGroups/mg",
        "subscriptions/other",
        "' /providers/Microsoft.Management/managementGroups/mg'",
        "/subscriptions/pinned/../../providers/Microsoft.Management/managementGroups/mg",
        "./providers/Microsoft.Management/managementGroups/mg",
        "x/../providers/Microsoft.Management/managementGroups/mg",
        "/subscriptions/pinned/%2e%2e/%2E%2E/providers/Microsoft.Management/managementGroups/mg",
        "/subscriptions/pinned%2F..%2Fother",
        "'.\\\\providers/Microsoft.Management/managementGroups/mg'",
        "/subscriptions/pinned/x%5C..%5C..%5Cproviders/mg",
      ]) {
        expect(isAzCommandAllowed(`role assignment list --scope ${scope}`, options).allowed).toBe(
          false,
        );
      }
      expect(isAzCommandAllowed("role assignment list --scope=/", options).allowed).toBe(false);
      expect(isAzCommandAllowed("role assignment list -s/providers/x", options).allowed).toBe(
        false,
      );
      expect(
        isAzCommandAllowed("role assignment list --scope /subscriptions/pinned", options).allowed,
      ).toBe(true);
      expect(
        isAzCommandAllowed(
          "role assignment list --scope subscriptions/pinned/resourceGroups/rg",
          options,
        ).allowed,
      ).toBe(true);
      expect(isAzCommandAllowed("role assignment list --scope /subscriptions/pinned").allowed).toBe(
        false,
      );
    });

    it("refuses resource IDs naming another subscription", () => {
      const options = { subscription: "PINNED" };
      const id = (subscription: string) =>
        `monitor metrics list --resource /subscriptions/${subscription}/resourceGroups/rg/providers/p/t/n`;
      expect(isAzCommandAllowed(id("pinned"), options).allowed).toBe(true);
      const foreign = isAzCommandAllowed(id("other"), options);
      expect(foreign.allowed).toBe(false);
      expect(foreign.reason).toContain("other");
      expect(
        isAzCommandAllowed("role assignment list --scope /subscriptions/other", options).allowed,
      ).toBe(false);
    });

    it("refuses an empty -g that leaves --app used as a raw GUID", () => {
      expect(
        isAzCommandAllowed(
          "monitor app-insights query --apps 1234 -g rg --resource-group= --analytics-query T",
        ).allowed,
      ).toBe(false);
      expect(
        isAzCommandAllowed("monitor app-insights query --apps 1234 -g rg -g= --analytics-query T")
          .allowed,
      ).toBe(false);
    });

    it("refuses arg() and bracket-quoted cross-resource functions", () => {
      expect(
        isAzCommandAllowed(
          "monitor log-analytics query -w ws --analytics-query 'arg(\"\").Resources'",
        ).allowed,
      ).toBe(false);
      expect(
        isAzCommandAllowed(
          "monitor log-analytics query -w ws --analytics-query \"['workspace']('x').T\"",
        ).allowed,
      ).toBe(false);
      expect(
        isAzCommandAllowed(
          "monitor log-analytics query -w ws --analytics-query 'T | summarize arg_max(TimeGenerated, *)'",
        ).allowed,
      ).toBe(true);
    });

    it("keeps --ids refused for Entra, allowing only --id", () => {
      expect(isAzCommandAllowed("ad user show --ids x", { allowEntra: true }).allowed).toBe(false);
    });

    it("names the abbreviation in the allowlist hint only when one was used", () => {
      const options = { allowedResourceGroups: ["rg-a"] };
      expect(isAzCommandAllowed("vm list -g rg-evil", options).hint).not.toContain("counts as");
      expect(
        isAzCommandAllowed("monitor metrics list --resource vm1 --resource-type t", options).hint,
      ).toContain("'--resource' counts as --resource-group");
    });
  });

  describe("reads above the subscription", () => {
    const tenantWide = [
      "account list",
      "account tenant list",
      "account management-group list",
      "deployment tenant list",
      "deployment mg list --management-group-id mg",
      "stack mg list --management-group-id mg",
      "billing account list",
      "reservations reservation-order list",
      "consumption reservation summary list --grain daily",
      "policy definition list --management-group mg",
      "policy set-definition list --management-g mg",
      "policy state list -m mg",
      "policy state list -mmg",
      "deployment operation tenant list -n dep",
      "deployment operation mg list -m mg -n dep",
      "stack-whatif mg list -m mg",
      "private-link association list -mmg",
    ];

    it("are refused unless the profile opts in", () => {
      for (const cmd of tenantWide) {
        const result = isAzCommandAllowed(cmd);
        expect(result.allowed).toBe(false);
        expect(result.hint).toContain("allowTenantScope");
      }
    });

    it("are allowed once the profile opts in", () => {
      for (const cmd of tenantWide) {
        expect(isAzCommandAllowed(cmd, { allowTenantScope: true }).allowed).toBe(true);
      }
    });

    it("leave subscription-scoped neighbours alone", () => {
      expect(isAzCommandAllowed("account show").allowed).toBe(true);
      expect(isAzCommandAllowed("policy definition list").allowed).toBe(true);
      expect(isAzCommandAllowed("deployment group list -g rg").allowed).toBe(true);
      expect(isAzCommandAllowed("consumption usage list").allowed).toBe(true);
      expect(isAzCommandAllowed("consumption usage list -m").allowed).toBe(true);
      expect(isAzCommandAllowed("deployment operation group list -g rg -n dep").allowed).toBe(true);
      expect(isAzCommandAllowed("stack sub list").allowed).toBe(true);
    });

    it("drop --subscription where az rejects it, and check the tenant for management groups", () => {
      const options = { allowTenantScope: true };
      const groups = isAzCommandAllowed("account management-group show -n mg", options);
      expect(groups.omitsSubscription).toBe(true);
      expect(groups.usesDefaultLoginTenant).toBe(true);

      const accounts = isAzCommandAllowed("account list", options);
      expect(accounts.omitsSubscription).toBe(true);
      expect(accounts.usesDefaultLoginTenant).toBeUndefined();

      const billing = isAzCommandAllowed("billing account list", options);
      expect(billing.omitsSubscription).toBeUndefined();
      expect(billing.usesDefaultLoginTenant).toBeUndefined();
    });
  });
});
