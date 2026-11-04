/** The package's values (DES-014 R-10) with the apps' names, for the editor's choices. */
export declare const VOCABULARY: {
    $comment: string;
    activities: string[];
    genres: string[];
    features: string[];
    spotKinds: {
        shrine: string;
        temple: string;
        church: string;
        worship: string;
        historic: string;
        museum: string;
        gallery: string;
        viewpoint: string;
        artwork: string;
        attraction: string;
        park: string;
        garden: string;
        beach: string;
        water: string;
        nature: string;
        restaurant: string;
        cafe: string;
        sweets: string;
        food_shop: string;
        market: string;
        crafts: string;
        shop: string;
    };
    talkLevels: string[];
    talkEvents: string[];
    guideLengths: string[];
    sounds: string[];
    slots: {
        "prompts/guide/persona.md": number;
        "prompts/guide/focus.md": number;
        "prompts/companion/persona.md": number;
        "prompts/companion/topics.md": number;
        "prompts/companion/events/start.md": number;
        "prompts/companion/events/revisit.md": number;
        "prompts/companion/events/milestone.md": number;
        "prompts/companion/events/rest.md": number;
        "prompts/companion/events/finish.md": number;
    };
    slotsTotal: number;
    cueEvents: string[];
    narration: string[];
    repeat: string[];
    presentAs: {
        speak: string[];
        card: string[];
        notify: string[];
        sheet: string[];
        play: string[];
        ambient: string[];
        fullscreen: string[];
    };
    materialTypes: string[];
    textChars: number;
    apps: Record<string, string>;
};
/** Which features each app has, as a line under the editor's choice of features. */
export declare const KNOWN_APPS_FOR_SCREEN: string;
