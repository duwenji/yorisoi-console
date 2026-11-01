package console.validator

import io.github.duwenji.yorisoi.core.format.material.Grants
import org.junit.Assert.assertEquals
import org.junit.Test

/** A collection's grants survive being stored and read back, so a channel using it isn't rejected (API-CHANNEL-LIST P-15). */
class StoredGrantsTest {
    private fun roundTrip(g: Grants): Grants = StoredGrants.read(Handler.av(StoredGrants.write(g)).m())

    @Test
    fun `publishers, apps and grounding come back as they were stored`() {
        for (g in listOf(
            Grants.EVERYONE,
            Grants(null, grounding = true),
            Grants(setOf("sg1b", "sg1a")),
            Grants(setOf("sg1a"), apps = setOf("sanpoguide"), grounding = true),
        )) assertEquals(g, roundTrip(g))
    }

    @Test
    fun `a listing stored without grants allows no one`() {
        assertEquals(Grants(emptySet()), StoredGrants.read(null))
    }
}
