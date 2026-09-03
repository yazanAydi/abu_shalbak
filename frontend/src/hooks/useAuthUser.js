import { useEffect, useState } from "react";
import { getUser, subscribeUser } from "../utils/auth";

export default function useAuthUser() {
  const [user, setUserState] = useState(() => getUser());

  useEffect(() => subscribeUser(setUserState), []);

  return user;
}
