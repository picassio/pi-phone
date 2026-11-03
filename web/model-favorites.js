// Favorite models (PP-350, after pi-pocket 0.28 #169): the models a person starred, kept with them on the server so
// every device of theirs and Pi (`models.favorites`, the models tool) see the same. A star is a shortcut in the model
// picker only: it allows nothing for subagents.
import { api, attempt, store } from "./store.js";

/** The models this person starred, `provider/modelId`, in the order starred. */
export const favoriteModels = () => store.state.me?.favoriteModels ?? [];

/** Whether a model (as the model list has it) is one of this person's favorites. */
export const isFavoriteModel = (model) => favoriteModels().includes(`${model.provider}/${model.id}`);

/** Star a model, or take its star away; the list comes back from the server, and to every device of theirs. */
export function setModelFavorite(spec, favorite) {
    return attempt(async () => {
        const { favoriteModels: list } = await api("model-favorites", { model: spec, favorite });

        if (store.state.me) {
            store.set({ me: { ...store.state.me, favoriteModels: list } });
        }
    });
}
