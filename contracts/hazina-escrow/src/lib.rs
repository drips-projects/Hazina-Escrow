#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env, String,
};

const MAX_BASIS_POINTS: u32 = 10_000;
const MAX_EXPIRY_SECONDS: u64 = 30 * 24 * 60 * 60;

#[contracttype]
pub enum DataKey {
    Admin,
    PlatformFee,
    EscrowCount,
    Paused,
}

#[contracttype]
pub enum EscrowKey {
    Record(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    EscrowNotFound = 3,
    AlreadyReleased = 4,
    AlreadyRefunded = 5,
    NotBuyer = 6,
    NotExpired = 7,
    InvalidInput = 8,
    BuyerNotConfirmed = 9,
    AlreadyConfirmed = 10,
    NotSeller = 11,
    Expired = 12,
    NotPaused = 13,
}

#[contracttype]
#[derive(Clone)]
pub struct EscrowRecord {
    pub escrow_id: u64,
    pub dataset_id: String,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub token: Address,
    pub deadline: u64,
    pub buyer_confirmed: bool,
    pub released: bool,
    pub refunded: bool,
}

#[contract]
pub struct HazinaEscrow;

#[contractimpl]
impl HazinaEscrow {
    pub fn initialize(env: Env, admin: Address, platform_fee_bps: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if platform_fee_bps > MAX_BASIS_POINTS {
            return Err(Error::InvalidInput);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFee, &platform_fee_bps);
        env.storage().instance().set(&DataKey::EscrowCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn lock(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        dataset_id: String,
        expiry_seconds: u64,
    ) -> Result<u64, Error> {
        buyer.require_auth();
        if amount <= 0 || expiry_seconds == 0 || expiry_seconds > MAX_EXPIRY_SECONDS {
            return Err(Error::InvalidInput);
        }

        let now = env.ledger().timestamp();
        let deadline = now.saturating_add(expiry_seconds);
        if deadline <= now {
            return Err(Error::InvalidInput);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let record = EscrowRecord {
            escrow_id: id,
            dataset_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            amount,
            token: token.clone(),
            deadline,
            buyer_confirmed: false,
            released: false,
            refunded: false,
        };
        env.storage().persistent().set(&EscrowKey::Record(id), &record);
        env.storage().instance().set(&DataKey::EscrowCount, &(id + 1));

        env.events().publish(
            (symbol_short!("locked"),),
            (id, buyer, seller, amount, deadline),
        );
        Ok(id)
    }

    pub fn confirm_delivery(env: Env, escrow_id: u64, buyer: Address) -> Result<(), Error> {
        buyer.require_auth();
        let mut record = Self::read_escrow(&env, escrow_id)?;
        if record.buyer != buyer {
            return Err(Error::NotBuyer);
        }
        if record.buyer_confirmed {
            return Err(Error::AlreadyConfirmed);
        }
        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }

        record.buyer_confirmed = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.events()
            .publish((symbol_short!("confirm"),), (escrow_id, buyer));
        Ok(())
    }

    pub fn release(env: Env, admin: Address, escrow_id: u64) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        let mut record = Self::read_escrow(&env, escrow_id)?;
        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }
        if !record.buyer_confirmed {
            return Err(Error::BuyerNotConfirmed);
        }
        if env.ledger().timestamp() > record.deadline {
            return Err(Error::Expired);
        }

        Self::distribute_locked_funds(&env, &admin, &mut record);
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        Ok(())
    }

    pub fn refund(env: Env, admin: Address, escrow_id: u64) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        let mut record = Self::read_escrow(&env, escrow_id)?;
        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }
        if env.ledger().timestamp() > record.deadline {
            return Err(Error::Expired);
        }

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.buyer, &record.amount);
        record.refunded = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.events().publish(
            (symbol_short!("refunded"),),
            (escrow_id, record.buyer, record.amount),
        );
        Ok(())
    }

    pub fn claim_expired(env: Env, escrow_id: u64, seller: Address) -> Result<(), Error> {
        seller.require_auth();
        let mut record = Self::read_escrow(&env, escrow_id)?;
        if record.seller != seller {
            return Err(Error::NotSeller);
        }
        if record.released {
            return Err(Error::AlreadyReleased);
        }
        if record.refunded {
            return Err(Error::AlreadyRefunded);
        }
        if env.ledger().timestamp() <= record.deadline {
            return Err(Error::NotExpired);
        }

        let admin = Self::get_admin(&env);
        Self::distribute_locked_funds(&env, &admin, &mut record);
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.events().publish(
            (symbol_short!("expired"),),
            (escrow_id, record.seller, record.amount),
        );
        Ok(())
    }

    pub fn emergency_withdraw(
        env: Env,
        admin: Address,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if amount <= 0 {
            return Err(Error::InvalidInput);
        }
        if !Self::is_paused(&env) {
            return Err(Error::NotPaused);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &to, &amount);
        env.events()
            .publish((symbol_short!("emerg_wd"),), (token, to, amount));
        Ok(())
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowRecord, Error> {
        Self::read_escrow(&env, escrow_id)
    }

    pub fn get_fee(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFee)
            .unwrap_or(500)
    }

    fn distribute_locked_funds(env: &Env, admin: &Address, record: &mut EscrowRecord) {
        let fee_bps = Self::get_fee(env.clone());
        let platform_cut = record.amount * fee_bps as i128 / MAX_BASIS_POINTS as i128;
        let seller_cut = record.amount - platform_cut;
        let token_client = token::Client::new(env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.seller, &seller_cut);
        if platform_cut > 0 {
            token_client.transfer(&env.current_contract_address(), admin, &platform_cut);
        }
        record.released = true;
        env.events().publish(
            (symbol_short!("released"),),
            (record.escrow_id, record.seller.clone(), seller_cut, platform_cut),
        );
    }

    fn read_escrow(env: &Env, escrow_id: u64) -> Result<EscrowRecord, Error> {
        env.storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .ok_or(Error::EscrowNotFound)
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin = Self::get_admin(env);
        if admin != *caller {
            panic_with_error!(env, Error::NotAdmin);
        }
    }

    fn get_admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::InvalidInput))
    }

    fn is_paused(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, String,
    };

    fn setup() -> (
        Env,
        HazinaEscrowClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1000);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let usdc_admin = StellarAssetClient::new(&env, &usdc);
        usdc_admin.mint(&buyer, &1_000_0000000);
        usdc_admin.mint(&admin, &1_000_0000000);

        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        (env, client, admin, buyer, seller, usdc)
    }

    #[test]
    fn release_fails_without_confirmation() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &2_000_000,
            &String::from_str(&env, "ds-1"),
            &3600,
        );
        let result = client.try_release(&admin, &escrow_id);
        assert_eq!(result, Err(Ok(Error::BuyerNotConfirmed)));
    }

    #[test]
    fn release_succeeds_after_buyer_confirmation() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 2_000_000;
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &String::from_str(&env, "ds-2"),
            &3600,
        );

        client.confirm_delivery(&escrow_id, &buyer);
        client.release(&admin, &escrow_id);

        let seller_expected = amount * 95 / 100;
        let admin_expected = amount - seller_expected;
        assert_eq!(token_client.balance(&seller), seller_expected);
        assert_eq!(
            token_client.balance(&admin),
            1_000_0000000 + admin_expected
        );
    }

    #[test]
    fn confirm_delivery_rejects_non_buyer() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &2_000_000,
            &String::from_str(&env, "ds-3"),
            &3600,
        );
        let result = client.try_confirm_delivery(&escrow_id, &seller);
        assert_eq!(result, Err(Ok(Error::NotBuyer)));
    }

    #[test]
    fn claim_expired_fails_before_deadline() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &2_000_000,
            &String::from_str(&env, "ds-4"),
            &3600,
        );
        let result = client.try_claim_expired(&escrow_id, &seller);
        assert_eq!(result, Err(Ok(Error::NotExpired)));
    }

    #[test]
    fn seller_can_claim_after_deadline() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 2_000_000;
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &String::from_str(&env, "ds-5"),
            &60,
        );

        env.ledger().set_timestamp(1061);
        client.claim_expired(&escrow_id, &seller);
        assert_eq!(token_client.balance(&seller), amount * 95 / 100);
    }

    #[test]
    fn emergency_withdraw_requires_pause_and_admin() {
        let (env, client, admin, _buyer, seller, usdc) = setup();

        let token_client = TokenClient::new(&env, &usdc);
        let contract_address = env.current_contract_address();
        let token_admin = StellarAssetClient::new(&env, &usdc);
        token_admin.mint(&contract_address, &1_000_000);

        let not_paused = client.try_emergency_withdraw(&admin, &usdc, &seller, &100_000);
        assert_eq!(not_paused, Err(Ok(Error::NotPaused)));

        client.pause(&admin);
        client.emergency_withdraw(&admin, &usdc, &seller, &100_000);
        assert_eq!(token_client.balance(&seller), 100_000);
    }

    #[test]
    fn emergency_withdraw_rejects_non_admin() {
        let (env, client, admin, _buyer, seller, usdc) = setup();
        let impostor = Address::generate(&env);
        client.pause(&admin);
        let result = client.try_emergency_withdraw(&impostor, &usdc, &seller, &10);
        assert_eq!(result, Err(Err(Error::NotAdmin)));
    }
}
