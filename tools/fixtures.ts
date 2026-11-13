// Fetches every test bundle that isn't in the repo into .cache/, checked against its pinned sha256.
import { fetchFixture, OUTSIDE_FIXTURES } from "../test/fetch-fixture.ts";

for (const fixture of OUTSIDE_FIXTURES) {
    await fetchFixture(fixture);
    console.log(`${fixture.name}  ${fixture.licence}  ${fixture.source}`);
}
