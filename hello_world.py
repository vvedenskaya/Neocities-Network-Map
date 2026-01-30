def calculator():
    print("Simple Calculator")
    print("Select operation")
    print("1. Addition (+)")
    print("2. Subtraction (-)")
    print("3. Multiplication (*)")
    print("4. Division (/)")


    choice = input("Enter operation number (1/2/3/4): ")

    if choice in ("1", "2", "3", "4"):
        try:
            num1 = float(input("Enter your first num: "))
            num2 = float(input("Enter your second num: "))

            if choice == '1':
                print(f"Result: {num1} + {num2} = {num1 + num2}")
            elif choice == '2':
                print(f"Result: {num1} - {num2} = {num1 - num2}")
            elif choice == '3':
                print(f"Result: {num1} * {num2} = {num1 * num2}")
            elif choice == '4':
                if num2 != 0:
                    print(f"Result: {num1} / {num2} = {num1 / num2}")
                else:
                    print("Error: Cannot divide by zero!")
        except ValueError:
            print("Enter only numbers")
    else:
        print("Error: Invalid operation choice.")

if __name__ == "__main__":
    calculator()
