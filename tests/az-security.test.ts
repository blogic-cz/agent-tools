import { describe, expect, it } from "vitest";

import { BLOCKED_VERBS, READ_ONLY_VERBS } from "#az/config";
import {
  extractResourceGroups,
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
    const options = { allowedResourceGroups: ["rg-a"] };
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
        isAzCommandAllowed("role assignment list --scope /subscriptions/s/resourceGroups/rg-evil")
          .allowed,
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
});
