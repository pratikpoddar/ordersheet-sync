import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>OrderSheet Sync</h1>
        <p className={styles.text}>Your Shopify orders in Google Sheets, always up to date.</p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">Log in</button>
          </Form>
        )}
        <ul className={styles.list}>
          <li><strong>Accurate</strong>. One row per order, updated in place. No duplicates.</li>
          <li><strong>Automatic</strong>. New and changed orders sync on their own.</li>
          <li><strong>Private</strong>. We can only see the one sheet we create for you.</li>
        </ul>
        <p className={styles.text}><a href="/privacy">Privacy policy</a></p>
      </div>
    </div>
  );
}
